import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { NOT_YOURS, ownedSignal } from '../auth/ownership.js';
import { loadSignals } from '../discovery/scoring.js';
import type { RequireProfile } from './types.js';

export function registerPreferenceRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get('/api/preferences', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const signals = await prisma.preferenceSignal.findMany({
      where: { profileId: profile.id },
      orderBy: { weight: 'desc' },
    });
    return {
      likes: signals.filter((s) => s.weight > 0.2).slice(0, 40),
      dislikes: signals.filter((s) => s.weight < -0.2).reverse().slice(0, 40),
      total: signals.length,
    };
  });

  app.delete<{ Params: { id: string } }>('/api/preferences/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const signal = await ownedSignal(profile.id, req.params.id);
    if (!signal) return reply.code(404).send(NOT_YOURS);
    await prisma.preferenceSignal.delete({ where: { id: signal.id } });
    return { ok: true };
  });

  /** Manually tell it something, instead of waiting for it to infer. */
  app.post('/api/preferences', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { term, weight } = z
      .object({ term: z.string().min(1), weight: z.number().min(-4).max(4) })
      .parse(req.body);
    const signal = await prisma.preferenceSignal.upsert({
      where: { profileId_term: { profileId: profile.id, term: term.toLowerCase().trim() } },
      create: { profileId: profile.id, term: term.toLowerCase().trim(), weight, origin: 'STATED' },
      update: { weight, origin: 'STATED' },
    });
    return { signal, total: (await loadSignals(profile.id)).size };
  });
}
