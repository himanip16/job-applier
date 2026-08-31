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
 * accepts that with Secure, which in turn means https. Over plain http (local
 * development) both are dropped, since a Secure cookie would simply never be
 * stored and sign-in would appear to succeed and then not work.
 *
 * For local development with different ports, we use SameSite=None without Secure
 * to allow cross-site cookies on http (browsers allow this for localhost).
 */
function serialiseCookie(value: string, expiresAt: Date): string {
  const isLocalhost = process.env.PUBLIC_API_URL?.includes('localhost') || 
                      process.env.RENDER_EXTERNAL_URL?.includes('localhost') ||
                      !process.env.PUBLIC_API_URL && !process.env.RENDER_EXTERNAL_URL;
  const crossSite = process.env.COOKIE_CROSS_SITE !== 'false' && (isHttps() || isLocalhost);
  const bits = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (crossSite) {
    bits.push('SameSite=None');
    if (isHttps()) bits.push('Secure');
  } else {
    bits.push('SameSite=Lax');
  }
  return bits.join('; ');
}

function isHttps(): boolean {
  // Render, Vercel and every other managed host terminates TLS in front of the
  // process, so the app itself only ever speaks http. PUBLIC_URL is how it
  // learns what the browser actually sees.
  const url = process.env.PUBLIC_API_URL ?? process.env.RENDER_EXTERNAL_URL ?? '';
  return url.startsWith('https://');
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      return raw || null;
    }
  }
  return null;
}
