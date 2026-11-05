import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { prisma } from '../lib/db.js';
import { hashPassword, verifyPassword, passwordProblem } from '../auth/passwords.js';
import { createSession, destroySession, currentUser, setSessionCookie, clearSessionCookie, readCookie, SESSION_COOKIE } from '../auth/sessions.js';
import { config } from '../lib/config.js';
import {
  createPasswordResetToken,
  completePasswordReset,
} from '../auth/password-reset.js';
import { sendPasswordResetEmail } from '../lib/email.js';

/** Precomputed valid scrypt hash for timing-safe login checks when user doesn't exist. */
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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
  password: z.string().min(10).max(200),
});

/** Deliberately identical for "no such account" and "wrong password". */
const BAD_CREDENTIALS = 'That email and password do not match an account.';

export function registerAuthRoutes(app: FastifyInstance) {
  // Register rate limiting plugin
  app.register(rateLimit, {
    max: 10, // 10 requests
    timeWindow: '1 minute', // per minute
    errorResponseBuilder: (req, context) => ({
      error: 'Too many requests. Please try again later.',
    }),
  });

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

    // Basic email validation - must have @, domain with at least one dot, and valid characters
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return reply.code(400).send({ error: 'That does not look like a valid email address.' });
    const weak = passwordProblem(parsed.data.password);
    if (weak) return reply.code(400).send({ error: weak });

    if (await prisma.user.findUnique({ where: { email } })) {
      // Not a secret: the sign-up form would leak it anyway, and pretending
      // otherwise just means the person cannot work out why they cannot get in.
      return reply.code(409).send({ error: 'There is already an account with that email. Sign in instead.' });
    }

    let user: { id: string; email: string } | null = null;
    let adoptedExistingProfile = false;
    try {
      user = await prisma.$transaction(async (tx) => {
        // Create user
        const createdUser = await tx.user.create({
          data: { email, passwordHash: await hashPassword(parsed.data.password) },
        });

        // Adopt the pre-sign-in profile rather than stranding it. This is for single-user
        // migrations where a profile existed before sign-in was implemented. We adopt
        // the first orphan profile found - if multiple orphans exist, this is non-deterministic,
        // but that should not happen in normal operation.
        const orphan = await tx.profile.findFirst({
          where: { userId: null },
          orderBy: { createdAt: 'asc' },
        });
        if (orphan) {
          await tx.profile.update({ where: { id: orphan.id }, data: { userId: createdUser.id } });
          adoptedExistingProfile = true;
        }

        return { id: createdUser.id, email: createdUser.email };
      });
    } catch (err) {
      // Handle race condition: another request may have created the user first
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'There is already an account with that email. Sign in instead.' });
      }
      throw err;
    }

    // user should never be null here since transaction would have thrown
    if (!user) {
      return reply.code(500).send({ error: 'Failed to create user.' });
    }

    await startSession(reply, req, user.id);
    return { user, adoptedExistingProfile };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = Credentials.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: BAD_CREDENTIALS });
    const email = parsed.data.email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    // Hash anyway when there is no such user, so the response time does not
    // say whether the address is registered. Use a valid precomputed hash.
    const ok = user
      ? await verifyPassword(parsed.data.password, user.passwordHash)
      : await verifyPassword(parsed.data.password, DUMMY_HASH);
    if (!user || !ok) return reply.code(401).send({ error: BAD_CREDENTIALS, code: 'BAD_CREDENTIALS' });

    // Check for existing recent session to prevent double-click creating multiple sessions
    const recentSession = await prisma.session.findFirst({
      where: {
        userId: user.id,
        expiresAt: { gt: new Date() },
        createdAt: { gt: new Date(Date.now() - 60 * 1000) }, // Created within last minute
      },
    });

    if (recentSession) {
      // Reuse existing session for idempotency
      setSessionCookie(reply, recentSession.token, recentSession.expiresAt);
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      return { user: { id: user.id, email: user.email } };
    }

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
    if (!user) return reply.code(401).send({ error: 'Sign in first.', code: 'AUTH_REQUIRED' });

    const body = z
      .object({ current: z.string().min(1).max(200), next: z.string().min(10).max(200) })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Give your current and new password.' });

    const weak = passwordProblem(body.data.next);
    if (weak) return reply.code(400).send({ error: weak });

    // Hash password before transaction (CPU work doesn't need DB)
    const passwordHash = await hashPassword(body.data.next);

    try {
      await prisma.$transaction(async (tx) => {
        // Verify current password within transaction
        const row = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
        if (!(await verifyPassword(body.data.current, row.passwordHash))) {
          throw new Error('That is not your current password.');
        }

        // Update password
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash },
        });

        // Invalidate all other sessions (keep current session)
        const keep = readCookie(req.headers.cookie, SESSION_COOKIE);
        await tx.session.deleteMany({
          where: { userId: user.id, ...(keep ? { NOT: { token: keep } } : {}) },
        });
      });

      return { ok: true };
    } catch (error) {
      const message = (error as Error).message;
      if (message === 'That is not your current password.') {
        return reply.code(401).send({ error: message });
      }
      throw error;
    }
  });

  /**
   * Request a password reset.
   *
   * This endpoint is deliberately permissive: it always returns success,
   * even if the email doesn't exist. This prevents account enumeration.
   */
  app.post('/api/auth/reset-request', {
    config: {
      rateLimit: {
        max: 3, // 3 requests
        timeWindow: '15 minutes', // per 15 minutes (stricter than global limit)
      },
    },
  }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().min(3).max(320) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Give an email address.' });

    const email = body.data.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      const token = await createPasswordResetToken(user.id);
      const resetUrl = `${config.webOrigin}/reset-complete?token=${token}`;
      
      // Send the password reset email
      const sent = await sendPasswordResetEmail({ email: user.email, resetUrl });
      
      if (!sent) {
        // Log failure but don't reveal to user (prevents account enumeration)
        console.error('[Auth] Failed to send password reset email', { email: user.email });
      }
      
      // In development mode, return the token for testing
      if (process.env.NODE_ENV === 'development') {
        return { ok: true, token, resetUrl, message: 'Development mode: token returned in response' };
      }
    }

    // Always return success to prevent account enumeration
    return { ok: true };
  });

  /**
   * Complete a password reset using a token.
   */
  app.post('/api/auth/reset-complete', {
    config: {
      rateLimit: {
        max: 5, // 5 requests
        timeWindow: '15 minutes', // per 15 minutes (stricter than global limit)
      },
    },
  }, async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(1),
        password: z.string().min(10).max(200),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Give a token and a new password.' });

    const weak = passwordProblem(body.data.password);
    if (weak) return reply.code(400).send({ error: weak });

    // Use the atomic completePasswordReset function
    const success = await completePasswordReset(body.data.token, body.data.password);
    
    if (!success) {
      return reply.code(400).send({ error: 'That reset link is invalid or has expired. Request a new one.' });
    }

    return { ok: true };
  });
}

async function startSession(reply: FastifyReply, req: FastifyRequest, userId: string) {
  const { token, expiresAt } = await createSession(userId, req.headers['user-agent']);
  setSessionCookie(reply, token, expiresAt);
}
