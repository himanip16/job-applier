import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeLabel, vectorize } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { NOT_YOURS } from '../auth/ownership.js';
import { rememberAnswer } from '../engine/answerBank.js';
import type { RequireProfile } from './types.js';

export function registerAnswerRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get('/api/answers', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const answers = await prisma.answer.findMany({
      where: { profileId: profile.id },
      orderBy: [{ timesUsed: 'desc' }, { updatedAt: 'desc' }],
    });
    return { answers: answers.map(({ vector: _vector, ...rest }) => rest) };
  });

  app.post('/api/answers', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { rawLabel, displayValue } = z
      .object({ rawLabel: z.string().trim().min(1), displayValue: z.string().trim().min(1) })
      .parse(req.body);
    const { vector: _vector, ...answer } = await rememberAnswer({
      profileId: profile.id,
      rawLabel,
      value: displayValue,
      displayValue,
      fieldKind: 'TEXT',
      source: 'USER',
      confidence: 1,
    });
    return { answer };
  });

  app.patch<{ Params: { id: string } }>('/api/answers/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await prisma.answer.findFirst({ where: { id: req.params.id, profileId: profile.id } }))) {
      return reply.code(404).send(NOT_YOURS);
    }
    const { displayValue, rawLabel } = z
      .object({ displayValue: z.string(), rawLabel: z.string().trim().min(1).optional() })
      .parse(req.body);
    // A reworded question must be re-indexed, or matching keeps using the old wording.
    const label = rawLabel
      ? { rawLabel, normalizedLabel: normalizeLabel(rawLabel), vector: vectorize(rawLabel) as unknown as Prisma.InputJsonValue }
      : {};
    const { vector: _vector, ...answer } = await prisma.answer.update({
      where: { id: req.params.id },
      data: { ...label, displayValue, value: displayValue, source: 'USER', confidence: 1 },
    });
    return { answer };
  });

  app.delete<{ Params: { id: string } }>('/api/answers/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await prisma.answer.findFirst({ where: { id: req.params.id, profileId: profile.id } }))) {
      return reply.code(404).send(NOT_YOURS);
    }
    await prisma.answer.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
}
