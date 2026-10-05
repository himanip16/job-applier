import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { NOT_YOURS } from '../auth/ownership.js';
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

  app.patch<{ Params: { id: string } }>('/api/answers/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await prisma.answer.findFirst({ where: { id: req.params.id, profileId: profile.id } }))) {
      return reply.code(404).send(NOT_YOURS);
    }
    const { displayValue } = z.object({ displayValue: z.string() }).parse(req.body);
    const answer = await prisma.answer.update({
      where: { id: req.params.id },
      data: { displayValue, value: displayValue, source: 'USER', confidence: 1 },
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
