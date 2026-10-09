import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { NOT_YOURS, ownedFact } from '../auth/ownership.js';
import type { RequireProfile } from './types.js';

const FactInput = z.object({
  key: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  value: z.string().max(5000),
  kind: z.enum(['TEXT', 'BOOLEAN', 'NUMBER', 'DATE', 'ENUM', 'LIST']).default('TEXT'),
});

export function registerFactsRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.post('/api/facts', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const parseResult = FactInput.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: 'Invalid input', issues: parseResult.error.issues });
    }
    const body = parseResult.data;
    const fact = await prisma.profileFact.upsert({
      where: { profileId_key: { profileId: profile.id, key: body.key } },
      create: { ...body, profileId: profile.id },
      update: { label: body.label, value: body.value, kind: body.kind },
    });
    return { fact };
  });

  app.delete<{ Params: { id: string } }>('/api/facts/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await ownedFact(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);
    await prisma.profileFact.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
}
