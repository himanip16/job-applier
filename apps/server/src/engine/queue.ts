import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { runApplication } from './runner.js';
import { markLeadProcessing, syncLead } from './leadSync.js';
import { give, tryTake, whenSlotFrees } from './slots.js';
import { tailorForApplication, wantedTailoring } from './tailorForApplication.js';

/**
 * A deliberately small in-process queue.
 *
 * Runs are long-lived and interactive - one can sit parked for an hour waiting
 * for you to answer a question - so the usual Redis/BullMQ shape buys nothing
 * here: there is no throughput problem to solve, and a job that blocks on human
 * input is a poor fit for a visibility-timeout model. Postgres holds the state,
 * this holds the concurrency limit, and there is one less service to run.
 *
 * Several forms fill at once, each in its own tab (RUN_CONCURRENCY, default
 * 5). See slots.ts for why a run waiting on you does not count against that.
 */
const queued: string[] = [];
/** Every run in flight, including ones parked on you. */
const active = new Set<string>();
/**
 * Runs that tailor the resume once they get a slot, not when they are queued.
 * A bulk apply queues everything at once; tailoring all of it up front would
 * spend minutes of model calls before the first form opened.
 */
const tailorFirst = new Set<string>();

whenSlotFrees(() => pump());

export function enqueue(applicationId: string, opts: { tailor?: boolean } = {}): void {
  if (active.has(applicationId) || queued.includes(applicationId)) return;
  if (opts.tailor) tailorFirst.add(applicationId);
  queued.push(applicationId);
  void markLeadProcessing(applicationId).catch(() => {});
  pump();
}

/** Where each waiting run stands in line, 1 being next. */
export function queuedRuns(): string[] {
  return [...queued];
}

export function activeRuns(): string[] {
  return [...active];
}

function pump(): void {
  while (queued.length && tryTake(queued[0]!)) {
    const id = queued.shift()!;
    active.add(id);
    const tailor = tailorFirst.delete(id);
    void (async () => {
      if (tailor) await tailorForApplication(id);
      await runApplication(id);
    })()
      .catch(async (err: unknown) => {
        await bus
          .emitEvent(id, 'ERROR', `Run crashed: ${(err as Error).message}`)
          .catch(() => {});
      })
      .finally(() => {
        active.delete(id);
        give(id);
        // Submitted -> Applied, failed -> back to For you, waiting on you -> stays Processing.
        void syncLead(id).catch(() => {});
      });
  }
}

/**
 * On boot, anything left mid-flight from a previous process is unrecoverable -
 * its browser page and its parked promise died with the process. Put those
 * back in the queue rather than leaving them stuck in a status that will never
 * change.
 */
export async function recoverInterruptedRuns(): Promise<number> {
  // Waiting for you at a wall needs the browser page, and that died with the
  // old process. Nothing is waiting any more, so say it stopped - unless a
  // submit may have landed, which a person has to check.
  const orphaned = await prisma.application.findMany({
    where: { status: 'NEEDS_HUMAN' },
    select: { id: true, blockedReason: true },
  });
  for (const app of orphaned) {
    if (/Submit was pressed|mid-submit|may have gone through/i.test(app.blockedReason ?? '')) continue;
    const interrupted = /Auto-apply was interrupted/i.test(app.blockedReason ?? '');
    await prisma.application.update({
      where: { id: app.id },
      data: {
        status: 'FAILED',
        blockedReason: interrupted
          ? 'Auto-apply was interrupted by a server restart. Review is back on; retry it if you still want it.'
          : `Stopped by a server restart while it was waiting for you (${(app.blockedReason ?? 'in the browser').slice(0, 160)}). Retry it.`,
      },
    });
    await syncLead(app.id);
  }

  const stuck = await prisma.application.findMany({
    // QUEUED too: the queue is in memory, so a run waiting its turn when the
    // process died is as orphaned as one that was mid-fill.
    where: { status: { in: ['QUEUED', 'PREPARING', 'FILLING', 'NEEDS_INPUT', 'REVIEW', 'SUBMITTING'] } },
    select: { id: true, status: true, requiresReview: true },
    // Back in line in the order they were queued.
    orderBy: { updatedAt: 'asc' },
  });
  for (const app of stuck) {
    // Autopilot never parks on questions: it set this aside and ended the run,
    // so nothing died with the process. Answering still restarts it.
    if (app.status === 'NEEDS_INPUT' && !app.requiresReview) continue;
    // Still waiting its turn: it never opened a page, so starting it now is
    // the same as starting it late. This is what keeps a bulk apply going
    // through a restart instead of failing the whole backlog.
    if (app.status === 'QUEUED') {
      enqueue(app.id, { tailor: await wantedTailoring(app.id) });
      continue;
    }
    // Auto-apply submits without asking, so a run it was part-way through never
    // resumes unattended after a restart: review goes back on and it waits for
    // you to start it again.
    if (!app.requiresReview) {
      await prisma.application.update({
        where: { id: app.id },
        data: {
          status: app.status === 'SUBMITTING' ? 'NEEDS_HUMAN' : 'FAILED',
          requiresReview: true,
          blockedReason:
            app.status === 'SUBMITTING'
              ? 'The server restarted mid-submit. Check the job board before retrying - it may have gone through.'
              : 'Auto-apply was interrupted by a server restart. Review is back on; retry it if you still want it.',
        },
      });
      await prisma.pendingQuestion.deleteMany({ where: { applicationId: app.id, answeredAt: null } });
      continue;
    }
    // SUBMITTING is the dangerous one: the click may have landed. Never retry
    // it automatically - a duplicate application is worse than a stalled one.
    const status = app.status === 'SUBMITTING' ? 'NEEDS_HUMAN' : 'QUEUED';
    await prisma.application.update({
      where: { id: app.id },
      data: {
        status,
        blockedReason:
          status === 'NEEDS_HUMAN'
            ? 'The server restarted mid-submit. Check the job board before retrying - it may have gone through.'
            : 'Restarted after a server restart.',
      },
    });
    // Clear stale questions; they will be re-asked against the fresh page.
    await prisma.pendingQuestion.deleteMany({ where: { applicationId: app.id, answeredAt: null } });
    // Marking it QUEUED is not the same as queueing it.
    if (status === 'QUEUED') enqueue(app.id);
  }
  return stuck.length;
}
