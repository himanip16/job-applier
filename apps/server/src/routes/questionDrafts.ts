import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { matchCanonical, normalizeLabel } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { NOT_YOURS } from '../auth/ownership.js';
import { rememberAnswer } from '../engine/answerBank.js';
import type { RequireProfile } from './types.js';

/**
 * An answer to a run's question, kept the moment you give it.
 *
 * The question popups used to save only when you sent a whole job's answers,
 * and that needs every required question filled in. If you answered three of
 * five and closed the popup, or the job was never applied to, those answers
 * were lost. Now each answer goes into your answer bank as you give it,
 * whether or not the job is applied to, so the next form that asks gets it.
 *
 * The question itself stays open: `answeredAt` is what tells a parked run to
 * carry on, and a half-answered job must not carry on. The draft is kept on
 * the row so reopening the popup shows what you typed.
 */
export function registerQuestionDraftRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.post<{ Params: { id: string } }>('/api/questions/:id/draft', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const question = await prisma.pendingQuestion.findFirst({
      where: { id: req.params.id, application: { profileId: profile.id } },
      include: { application: { include: { job: true } } },
    });
    if (!question) return reply.code(404).send(NOT_YOURS);

    const { value, remember } = z
      .object({ value: z.union([z.string(), z.array(z.string())]), remember: z.boolean() })
      .parse(req.body);

    // Already sent: the bank was written then, and the run has the answer.
    if (question.answeredAt) return { ok: true, saved: false };

    await prisma.pendingQuestion.update({
      where: { id: question.id },
      data: { answerValue: value as Prisma.InputJsonValue, remember },
    });

    const displayValue = Array.isArray(value) ? value.join(', ') : value.trim();
    if (!remember || !displayValue) return { ok: true, saved: false };

    const canonical = matchCanonical(question.rawLabel);
    await rememberAnswer({
      profileId: profile.id,
      canonicalKey: canonical?.key,
      rawLabel: question.rawLabel,
      value: Array.isArray(value) ? value : value.trim(),
      displayValue,
      fieldKind: question.fieldKind,
      options: (question.options ?? undefined) as { label: string }[] | undefined,
      source: 'USER',
      confidence: 1,
      scope: canonical?.perCompany ? 'PER_COMPANY' : 'GLOBAL',
      companyKey: normalizeLabel(question.application.job.company),
    });
    return { ok: true, saved: true };
  });
}
