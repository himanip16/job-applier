import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/passwords.js';
import {
  clearSessionCookie,
  createSession,
  currentUser,
  destroySession,
  readCookie,
  setSessionCookie,
  SESSION_COOKIE,
} from '../auth/sessions.js';
import {
  createPasswordResetToken,
  markPasswordResetTokenUsed,
  validatePasswordResetToken,
} from '../auth/password-reset.js';

/**
 * Signing in.
 *
 * Everything else in this app hangs off a Profile, and until now the server
 * simply took the first one in the table - fine for one person on a laptop,
 * wrong the moment it is on the internet. A User owns a Profile; a session
 * says which User is asking.
 */

const Credentials = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(200),
});

/** Deliberately identical for "no such account" and "wrong password". */
const BAD_CREDENTIALS = 'That email and password do not match an account.';

export function registerAuthRoutes(app: FastifyInstance) {
  /**
   * Who is asking, and whether anyone can sign up.
   *
   * The web app calls this before rendering anything, so it needs to answer
   * for a signed-out visitor too - hence 200 with `user: null` rather than a
   * 401, which the browser console would fill with red on every page load.
   */
  app.get('/api/auth/me', async (req) => {
    const user = await currentUser(req);
    if (!user) return { user: null, hasAccounts: (await prisma.user.count()) > 0 };
    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
      select: { id: true, fullName: true },
    });
    return { user, profile, hasAccounts: true };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const parsed = Credentials.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Give an email and a password.' });
    const email = parsed.data.email.toLowerCase();

    if (!email.includes('@')) return reply.code(400).send({ error: 'That does not look like an email address.' });
    const weak = passwordProblem(parsed.data.password);
    if (weak) return reply.code(400).send({ error: weak });

    if (await prisma.user.findUnique({ where: { email } })) {
      // Not a secret: the sign-up form would leak it anyway, and pretending
      // otherwise just means the person cannot work out why they cannot get in.
      return reply.code(409).send({ error: 'There is already an account with that email. Sign in instead.' });
    }

    const user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(parsed.data.password) },
    });

    // Adopt the pre-sign-in profile rather than stranding it. A single-user
    // install that has been running for weeks has all its history on a profile
    // with no owner, and the person creating the first account is that owner.
    const orphan = await prisma.profile.findFirst({ where: { userId: null } });
    if (orphan) await prisma.profile.update({ where: { id: orphan.id }, data: { userId: user.id } });

    await startSession(reply, req, user.id);
    return { user: { id: user.id, email: user.email }, adoptedExistingProfile: Boolean(orphan) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = Credentials.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: BAD_CREDENTIALS });
    const email = parsed.data.email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    // Hash anyway when there is no such user, so the response time does not
    // say whether the address is registered.
    const ok = user
      ? await verifyPassword(parsed.data.password, user.passwordHash)
      : await verifyPassword(parsed.data.password, 'scrypt$16384$8$1$AAAA$AAAA');
    if (!user || !ok) return reply.code(401).send({ error: BAD_CREDENTIALS });

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await startSession(reply, req, user.id);
    return { user: { id: user.id, email: user.email } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in first.' });

    const body = z
      .object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Give your current and new password.' });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verifyPassword(body.data.current, row.passwordHash))) {
      return reply.code(401).send({ error: 'That is not your current password.' });
    }
    const weak = passwordProblem(body.data.next);
    if (weak) return reply.code(400).send({ error: weak });

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.data.next) },
    });
    // Every other browser is signed out; the one that made the change is not.
    const keep = readCookie(req.headers.cookie, SESSION_COOKIE);
    await prisma.session.deleteMany({
      where: { userId: user.id, ...(keep ? { NOT: { token: keep } } : {}) },
    });
    return { ok: true };
  });

  /**
   * Request a password reset.
   *
   * This endpoint is deliberately permissive: it always returns success,
   * even if the email doesn't exist. This prevents account enumeration.
   */
  app.post('/api/auth/reset-request', async (req, reply) => {
    const body = z.object({ email: z.string().trim().min(3).max(320) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Give an email address.' });

    const email = body.data.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      const token = await createPasswordResetToken(user.id);
      // In a real implementation, you would send this token via email:
      // await sendPasswordResetEmail(user.email, token);
      // For development, return the token in the response
      if (process.env.NODE_ENV === 'development') {
        return { ok: true, token, message: 'Development mode: token returned in response' };
      }
    }

    // Always return success to prevent account enumeration
    return { ok: true };
  });

  /**
   * Complete a password reset using a token.
   */
  app.post('/api/auth/reset-complete', async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(1),
        password: z.string().min(1).max(200),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Give a token and a new password.' });

    const weak = passwordProblem(body.data.password);
    if (weak) return reply.code(400).send({ error: weak });

    const userId = await validatePasswordResetToken(body.data.token);
    if (!userId) {
      return reply.code(400).send({ error: 'That reset link is invalid or has expired. Request a new one.' });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(body.data.password) },
    });

    // Mark the token as used
    await markPasswordResetTokenUsed(body.data.token);

    // Sign out all sessions for this user
    await prisma.session.deleteMany({ where: { userId } });

    return { ok: true };
  });
}

async function startSession(reply: FastifyReply, req: FastifyRequest, userId: string) {
  const { token, expiresAt } = await createSession(userId, req.headers['user-agent']);
  setSessionCookie(reply, token, expiresAt);
}
