import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Prisma } from '../lib/db.js';
import { enqueue, activeRuns } from '../engine/queue.js';
import { submitAnswers, decideReview, continueRun } from '../engine/runner.js';
import { rememberAnswer } from '../engine/answerBank.js';
import { adapterFor } from '../ats/registry.js';
import { matchCanonical, normalizeLabel } from '@ja/shared';
import { NOT_YOURS, ownedApplication } from '../auth/ownership.js';
import { config } from '../lib/config.js';
import type { RequireProfile } from './discovery.js';

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

  app.get('/api/applications', async () => {
    const applications = await prisma.application.findMany({
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
        events: { orderBy: { createdAt: 'asc' }, take: 500 },
        pending: { orderBy: { createdAt: 'asc' } },
        artifacts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!application) return reply.code(404).send({ error: 'Not found' });
    return { application };
  });

  app.post<{ Params: { id: string } }>('/api/applications/:id/start', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await ownedApplication(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);
    await prisma.application.update({
      where: { id: req.params.id },
      data: { status: 'QUEUED', blockedReason: null },
    });
    enqueue(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/applications/:id/answers', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

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

    if (!delivered) {
      return reply.code(409).send({
        error: 'That run is not currently waiting for answers. They were saved to your answer bank; restart the application to use them.',
      });
    }
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
