import type { FastifyRequest } from 'fastify';
import { prisma } from '../lib/db.js';
import { currentUser } from './sessions.js';

/**
 * The dossier the caller is allowed to act on.
 *
 * Every feature in this app is scoped by profileId already, so making the app
 * multi-user is almost entirely a matter of this one function no longer
 * answering "the first row in the table".
 */
export async function requireProfile(
  req: { headers: { cookie?: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  const user = await currentUser(req as FastifyRequest);
  if (!user) {
    reply.code(401).send({ error: 'Sign in to use this.' });
    return null;
  }
  const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
  if (!profile) {
    reply.code(400).send({ error: 'Create your profile first (PUT /api/profile).' });
    return null;
  }
  return profile;
}

/**
 * Require authentication only, not necessarily a profile.
 * Used for endpoints that need user context but not profile data.
 */
export async function requireUser(
  req: { headers: { cookie?: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  const user = await currentUser(req as FastifyRequest);
  if (!user) {
    reply.code(401).send({ error: 'Sign in to use this.' });
    return null;
  }
  return user;
}

export type RequireUser = (
  req: { headers: { cookie?: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => Promise<{ id: string } | null>;
