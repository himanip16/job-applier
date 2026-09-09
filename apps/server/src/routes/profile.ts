import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { currentUser } from '../auth/sessions.js';
import type { RequireProfile } from './types.js';

const ProfileInput = z.object({
  email: z.string().email(),
  fullName: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().trim().default(''),
  phone: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  countryCode: z.string().trim().min(1).optional(),
  citizenship: z.string().trim().min(1).optional(),
  expectedCTC: z.string().trim().min(1).optional(),
  linkedin: z.string().url().optional(),
  github: z.string().url().optional(),
  website: z.string().url().optional(),
  portfolio: z.string().url().optional(),
  summary: z.string().trim().min(1).optional(),
});

export function registerProfileRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get('/api/profile', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in to use this.' });
    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
      include: { facts: { orderBy: { key: 'asc' } }, resumes: { orderBy: { createdAt: 'desc' } } },
    });
    return { profile };
  });

  app.put('/api/profile', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in to use this.' });
    const parseResult = ProfileInput.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: 'Invalid input', issues: parseResult.error.issues });
    }
    const body = parseResult.data;
    const profile = await prisma.profile.upsert({
      where: { userId: user.id },
      update: body,
      create: { ...body, userId: user.id },
    });
    // Sync email to User to prevent divergence
    if (profile.email !== user.email) {
      await prisma.user.update({ where: { id: user.id }, data: { email: profile.email } });
    }
    return { profile };
  });
}
