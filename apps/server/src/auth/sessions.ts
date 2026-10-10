import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/db.js';

/**
 * Sessions, as an opaque token in an httpOnly cookie.
 *
 * The token carries no claims and means nothing on its own - it is a lookup
 * key for a row. That is the whole reason to prefer it to a JWT here: signing
 * out has to actually end the session, and with a self-describing token the
 * best the server can do is ask the holder to forget it. Deleting a row is not
 * a request.
 *
 * No cookie library. The one cookie this app sets needs no signing, because
 * the token is itself the secret, and parsing one header is less code than
 * wiring a plugin.
 */

export const SESSION_COOKIE = 'ja_session';

/** Long enough not to nag a daily user, short enough to expire a stale laptop. */
const SESSION_DAYS = 30;

/** Maximum number of concurrent sessions per user to prevent unbounded growth. */
const MAX_SESSIONS_PER_USER = 5;

export interface SessionUser {
  id: string;
  email: string;
}

export async function createSession(
  userId: string,
  userAgent?: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  // Enforce session limit: delete oldest sessions if limit exceeded
  const sessionCount = await prisma.session.count({
    where: { userId, expiresAt: { gt: new Date() } },
  });

  if (sessionCount >= MAX_SESSIONS_PER_USER) {
    // Delete oldest sessions beyond the limit
    const sessionsToDelete = await prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: sessionCount - MAX_SESSIONS_PER_USER + 1,
      select: { id: true },
    });

    if (sessionsToDelete.length > 0) {
      await prisma.session.deleteMany({
        where: {
          id: { in: sessionsToDelete.map((s) => s.id) },
        },
      });
    }
  }

  await prisma.session.create({
    data: { token, userId, expiresAt, userAgent: userAgent?.slice(0, 300) ?? null },
  });
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { token } });
}

/** The signed-in user for this request, or null. Never throws. */
export async function currentUser(req: FastifyRequest): Promise<SessionUser | null> {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (!token) return null;

  const session = await prisma.session
    .findUnique({ where: { token }, include: { user: true } })
    .catch(() => null);
  if (!session) return null;

  if (session.expiresAt.getTime() < Date.now()) {
    // Tidy up on the way past, so expired rows do not accumulate for ever
    // without a scheduled job to sweep them.
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return { id: session.user.id, email: session.user.email };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.header('set-cookie', serialiseCookie(token, expiresAt));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', serialiseCookie('', new Date(0)));
}

/**
 * Cross-site by default, because the two halves are deployed apart.
 *
 * The web app is meant to sit on Vercel and the API on Render, which are
 * different sites, so the cookie has to be SameSite=None - and a browser only
 * accepts that with Secure, which in turn means https.
 *
 * For local development, Next.js proxies API requests through rewrites, making
 * them same-origin. This allows using SameSite=Lax without cross-origin issues.
 */
function serialiseCookie(value: string, expiresAt: Date): string {
  const isProduction = process.env.NODE_ENV === 'production';
  const https = isHttps();

  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `Expires=${expiresAt.toUTCString()}`,
  ];

  if (isProduction || https) {
    // Production or HTTPS: require SameSite=None with Secure for cross-origin
    bits.push('SameSite=None');
    bits.push('Secure');
  } else {
    // Local development: use SameSite=Lax (requests are proxied through Next.js)
    bits.push('SameSite=Lax');
  }

  return bits.join('; ');
}

function isHttps(): boolean {
  // Check explicit evidence of HTTPS deployment
  // 1. Explicit environment variables (most reliable)
  const url = process.env.PUBLIC_API_URL ?? process.env.RENDER_EXTERNAL_URL ?? '';
  if (url.startsWith('https://')) return true;
  if (url.startsWith('http://')) return false;

  // 2. Common production platforms that always use HTTPS
  if (process.env.VERCEL_ENV === 'production') return true;
  if (process.env.RENDER === 'true') return true;

  // 3. If we have no URL info, assume HTTP (safer default)
  // In production, you should set PUBLIC_API_URL explicitly
  return false;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue; // Skip malformed parts without '='
    if (eq === 0) continue; // Skip parts that start with '=' (unkeyed data)
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = trimmed.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      return raw || null;
    }
  }
  return null;
}
