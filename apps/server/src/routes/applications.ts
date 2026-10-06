import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Prisma } from '../lib/db.js';
import { enqueue, activeRuns } from '../engine/queue.js';
import { submitAnswers, decideReview, continueRun } from '../engine/runner.js';
import { rememberAnswer } from '../engine/answerBank.js';
import { ANSWER_POLL_MS } from '../engine/humanGate.js';
import { isParked, blockerKey } from '../engine/waiters.js';
import { syncLead } from '../engine/leadSync.js';
import { adapterFor } from '../ats/registry.js';
import { matchCanonical, normalizeLabel } from '@ja/shared';
import { NOT_YOURS, ownedApplication } from '../auth/ownership.js';
import { config } from '../lib/config.js';
import { tabLeftOpen } from '../browser/session.js';
import type { RequireProfile } from './types.js';

export function registerApplicationRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.post<{ Body: unknown }>('/api/applications', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const { url, autoStart, requiresReview, writeCoverLetter } = z
      .object({
        url: z.string().url(),
        autoStart: z.boolean().default(true),
        requiresReview: z.boolean().default(config.requireReview),
        writeCoverLetter: z.boolean().default(false),
      })
      .parse(req.body);

    const adapter = adapterFor(url);
    const job = await prisma.job.upsert({
      where: { url },
      create: { url, ats: adapter.id, company: 'pending', title: 'pending' },
      update: {},
    });

    const existing = await prisma.application.findUnique({
      where: { profileId_jobId: { profileId: profile.id, jobId: job.id } },
    });
    if (existing && existing.status === 'SUBMITTED') {
      return reply.code(409).send({
        error: 'You already applied to this job.',
        applicationId: existing.id,
        submittedAt: existing.submittedAt,
      });
    }

    const application =
      existing ??
      (await prisma.application.create({
        data: { profileId: profile.id, jobId: job.id, requiresReview, writeCoverLetter },
      }));

    if (existing) {
      await prisma.application.update({
        where: { id: existing.id },
        data: { status: 'QUEUED', blockedReason: null, requiresReview, writeCoverLetter },
      });
      await prisma.pendingQuestion.deleteMany({ where: { applicationId: existing.id, answeredAt: null } });
    }

    if (autoStart) enqueue(application.id);
    return { applicationId: application.id, ats: adapter.id, notes: adapter.notes };
  });

  app.get('/api/applications', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const applications = await prisma.application.findMany({
      where: { profileId: profile.id },
      include: { job: true, _count: { select: { pending: { where: { answeredAt: null } } } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return { applications, active: activeRuns() };
  });

  app.get<{ Params: { id: string } }>('/api/applications/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const application = await prisma.application.findFirst({
      where: { id: req.params.id, profileId: profile.id },
      include: {
        job: true,
        // The newest 500, not the oldest: an application retried a few times
        // otherwise shows only its first runs and never the one that matters.
        events: { orderBy: { createdAt: 'desc' }, take: 500 },
        pending: { orderBy: { createdAt: 'asc' } },
        artifacts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!application) return reply.code(404).send({ error: 'Not found' });
    application.events.reverse();
    const atWall = isParked(blockerKey(application.id));
    return {
      application,
      atWall,
      handoff: application.status === 'NEEDS_HUMAN' ? handoffKind(application, atWall) : null,
      tabOpen: tabLeftOpen(application.id),
    };
  });

  app.post<{ Params: { id: string } }>('/api/applications/:id/start', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await ownedApplication(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);
    // Re-queueing a submitted application applies to the same job twice.
    const requeued = await prisma.application.updateMany({
      where: { id: req.params.id, status: { not: 'SUBMITTED' } },
      data: { status: 'QUEUED', blockedReason: null },
    });
    if (requeued.count === 0) return reply.code(409).send({ error: 'You already applied to this job.' });
    // Unanswered questions belong to the run that died; the new one re-reads
    // the form and asks again. Answered ones are kept and reused.
    await prisma.pendingQuestion.deleteMany({ where: { applicationId: req.params.id, answeredAt: null } });
    enqueue(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/applications/:id/answers', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await ownedApplication(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);

    const { answers } = z
      .object({
        answers: z.array(
          z.object({
            fieldId: z.string(),
            questionId: z.string().optional(),
            value: z.union([z.string(), z.array(z.string())]),
            remember: z.boolean().default(true),
          }),
        ),
      })
      .parse(req.body);

    for (const a of answers) {
      if (a.questionId) {
        const question = await prisma.pendingQuestion.findUnique({
          where: { id: a.questionId },
        });
        if (!question || question.applicationId !== req.params.id) {
          continue;
        }
        await prisma.pendingQuestion.update({
          where: { id: a.questionId },
          data: {
            answeredAt: new Date(),
            answerValue: a.value as Prisma.InputJsonValue,
            remember: a.remember,
          },
        });
        if (a.remember) {
          const canonical = matchCanonical(question.rawLabel);
          const application = await prisma.application.findUnique({
            where: { id: req.params.id },
            include: { job: true },
          });
          await rememberAnswer({
            profileId: profile.id,
            canonicalKey: canonical?.key,
            rawLabel: question.rawLabel,
            value: a.value,
            displayValue: Array.isArray(a.value) ? a.value.join(', ') : a.value,
            fieldKind: question.fieldKind,
            options: (question.options ?? undefined) as { label: string }[] | undefined,
            source: 'USER',
            confidence: 1,
            scope: canonical?.perCompany ? 'PER_COMPANY' : 'GLOBAL',
            companyKey: application ? normalizeLabel(application.job.company) : undefined,
          });
        }
      }
    }

    const delivered = submitAnswers(req.params.id, answers.map((a) => ({
      fieldId: a.fieldId,
      value: a.value,
      remember: a.remember,
    })));

    if (delivered) return { ok: true };

    // Not parked in this process. The run may be alive in another one (started
    // from the terminal), which watches the database and carries on within a
    // poll or two; or it may be gone, in which case starting it again is what
    // you wanted - a fresh run reuses every answer already on this application.
    return { ok: true, ...(await resumeAfterAnswers(req.params.id)) };
  });

  async function resumeAfterAnswers(applicationId: string): Promise<{ resumed: 'elsewhere' | 'restarted' | 'waiting' }> {
    const statusOf = async () =>
      (await prisma.application.findUnique({ where: { id: applicationId }, select: { status: true } }))?.status;
    let status = await statusOf();
    if (status === 'NEEDS_INPUT') {
      // Possibly parked in another process, which picks the answers up from
      // the database within a poll or two. Give it that long first.
      for (let i = 0; i < 3 && status === 'NEEDS_INPUT'; i++) {
        await new Promise((r) => setTimeout(r, ANSWER_POLL_MS * 1.5));
        status = await statusOf();
      }
      if (status !== 'NEEDS_INPUT') return { resumed: 'elsewhere' };
    } else if (!(status === 'FAILED' || status === 'NEEDS_HUMAN') || activeRuns().includes(applicationId)) {
      // Running, finished, or cancelled. FAILED and NEEDS_HUMAN with no live
      // run here are ended runs (tab closed, set aside, server restarted):
      // nobody else will pick these answers up, so they go back in the queue.
      return { resumed: 'elsewhere' };
    }
    const open = await prisma.pendingQuestion.count({ where: { applicationId, answeredAt: null } });
    if (open > 0) return { resumed: 'waiting' };
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: 'QUEUED', blockedReason: 'Back in the queue with your answers.' },
    });
    enqueue(applicationId);
    return { resumed: 'restarted' };
  }

  /** "I checked: it did / did not go through" - for a submit nobody could confirm. */
  app.post<{ Params: { id: string } }>('/api/applications/:id/outcome', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await ownedApplication(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);
    const { submitted } = z.object({ submitted: z.boolean() }).parse(req.body);
    await prisma.application.update({
      where: { id: req.params.id },
      data: submitted
        ? { status: 'SUBMITTED', submittedAt: new Date(), confirmation: 'You confirmed it went through.', blockedReason: null }
        : { status: 'FAILED', blockedReason: 'Not submitted - you checked. Resume to fill it in again.' },
    });
    await syncLead(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/applications/:id/review', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await ownedApplication(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);
    const { approved, note } = z
      .object({ approved: z.boolean(), note: z.string().optional() })
      .parse(req.body);
    const delivered = decideReview(req.params.id, approved, note);
    if (!delivered) return reply.code(409).send({ error: 'That run is not waiting for review.' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/applications/:id/continue', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await ownedApplication(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);
    const { carryOn, note } = z
      .object({ carryOn: z.boolean().default(true), note: z.string().optional() })
      .parse(req.body ?? {});
    const delivered = continueRun(req.params.id, carryOn, note);
    if (!delivered) {
      return reply.code(409).send({
        error:
          'That run is not waiting at a wall. If it stopped before this server started, the ' +
          'browser page is gone — start it again and it will pick up the signed-in session.',
      });
    }
    return { ok: true };
  });
}

/**
 * NEEDS_HUMAN means four different things, and each wants a different button.
 * The UI used to guess which from the log text; the run says so instead.
 *
 *  - WALL               a live run is parked at a sign-in or captcha; it carries on
 *  - CAPTCHA_ON_SUBMIT  a live run pressed submit and the captcha challenged
 *  - UNCONFIRMED        submit was pressed and nobody could see whether it landed
 *  - SET_ASIDE          autopilot left the form in a tab for you and moved on
 *  - STOPPED            the run ended before the form (no form found, a wall)
 */
export type Handoff = 'WALL' | 'CAPTCHA_ON_SUBMIT' | 'UNCONFIRMED' | 'SET_ASIDE' | 'STOPPED';

function handoffKind(
  app: { blockedReason: string | null; events: Array<{ type: string; data: Prisma.JsonValue }> },
  atWall: boolean,
): Handoff {
  if (atWall) return 'WALL';
  // A restart mid-submit leaves no event behind, only this reason.
  if (/Submit was pressed|mid-submit|may have gone through/i.test(app.blockedReason ?? '')) return 'UNCONFIRMED';
  const last = [...app.events].reverse().find((e) => e.type === 'STATUS' || e.type === 'BLOCKED');
  const tagged = (last?.data as { handoff?: Handoff } | null)?.handoff;
  return tagged ?? 'STOPPED';
}
