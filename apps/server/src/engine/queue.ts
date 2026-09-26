import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { runApplication } from './runner.js';

/**
 * A deliberately small in-process queue.
 *
 * Runs are long-lived and interactive - one can sit parked for an hour waiting
 * for you to answer a question - so the usual Redis/BullMQ shape buys nothing
 * here: there is no throughput problem to solve, and a job that blocks on human
 * input is a poor fit for a visibility-timeout model. Postgres holds the state,
 * this holds the concurrency limit, and there is one less service to run.
 *
 * Concurrency is 1 by default and should stay there while HEADLESS=false:
 * parallel runs fight over window focus, and focus loss breaks combobox
 * interaction.
 */
const CONCURRENCY = Number(process.env.RUN_CONCURRENCY ?? 1);

const queued: string[] = [];
const active = new Set<string>();

export function enqueue(applicationId: string): void {
  if (active.has(applicationId) || queued.includes(applicationId)) return;
  queued.push(applicationId);
  pump();
}

export function activeRuns(): string[] {
  return [...active];
}

function pump(): void {
  while (active.size < CONCURRENCY && queued.length) {
    const id = queued.shift()!;
    active.add(id);
    void runApplication(id)
      .catch(async (err: unknown) => {
        await bus
          .emitEvent(id, 'ERROR', `Run crashed: ${(err as Error).message}`)
          .catch(() => {});
      })
      .finally(() => {
        active.delete(id);
        pump();
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
  const stuck = await prisma.application.findMany({
    // QUEUED too: the queue is in memory, so a run waiting its turn when the
    // process died is as orphaned as one that was mid-fill.
    where: { status: { in: ['QUEUED', 'PREPARING', 'FILLING', 'NEEDS_INPUT', 'REVIEW', 'SUBMITTING'] } },
    select: { id: true, status: true },
  });
  for (const app of stuck) {
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
