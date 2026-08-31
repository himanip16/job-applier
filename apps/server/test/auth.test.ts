import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Signing in.
 *
 * The app spent its life taking the first profile in the table, which is fine
 * for one person on a laptop and wrong the moment it is on the internet.
 */

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { registerAuthRoutes } = await import('../src/routes/auth.js');
const { hashPassword, verifyPassword, passwordProblem } = await import('../src/auth/passwords.js');
const { currentUser, SESSION_COOKIE, readCookie } = await import('../src/auth/sessions.js');
const {
  createPasswordResetToken,
  validatePasswordResetToken,
  markPasswordResetTokenUsed,
} = await import('../src/auth/password-reset.js');
const Fastify = (await import('fastify')).default;

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  await prisma.session.deleteMany({});
  await prisma.passwordReset.deleteMany({});
  await prisma.jobLead.deleteMany({});
  await prisma.profile.deleteMany({});
  await prisma.user.deleteMany({});
  app = Fastify();
  registerAuthRoutes(app);
  await app.ready();
});

const post = (url: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });

/** The cookie a response set, in the form a browser would send back. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers['set-cookie'] ?? '');
  const value = raw.split(';')[0] ?? '';
  return value;
}

describe('passwords', () => {
  it('round-trips, and rejects the wrong one', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$')).toBe(true);
    // Never the password itself, in any form.
    expect(stored).not.toContain('correct');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('Correct horse battery', stored)).toBe(false);
  });

  it('salts, so two people with the same password do not share a hash', async () => {
    expect(await hashPassword('the same password')).not.toBe(await hashPassword('the same password'));
  });

  it('returns false on a malformed stored hash instead of throwing', async () => {
    // A login route that can 500 on a bad row tells an attacker which rows are bad.
    for (const junk of ['', 'nonsense', 'scrypt$x$y$z$a$b', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword('anything', junk)).toBe(false);
    }
  });

  it('asks for length, not for a symbol', async () => {
    expect(passwordProblem('short')).toMatch(/10 characters/);
    expect(passwordProblem('a long enough passphrase')).toBeNull();
    // No composition rule: "Password1!" is worse than the phrase above and
    // every composition rule pushes people toward it.
    expect(passwordProblem('averylongandperfectlyfinepassphrase')).toBeNull();
  });
});

describe('registering and signing in', () => {
  it('creates the first account and signs it in', async () => {
    const res = await post('/api/auth/register', { email: 'A@Example.com', password: 'a good long password' });
    expect(res.statusCode).toBe(200);

    const cookie = sessionCookie(res);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');

    // Lower-cased on the way in, so "A@Example.com" and "a@example.com" are
    // the same account rather than two.
    const user = await prisma.user.findUnique({ where: { email: 'a@example.com' } });
    expect(user).toBeTruthy();

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect((me.json() as { user: { email: string } }).user.email).toBe('a@example.com');
  });

  it('adopts a profile that predates sign-in rather than stranding it', async () => {
    // Weeks of history on a profile with no owner; the person creating the
    // first account is that owner.
    const orphan = await prisma.profile.create({
      data: { email: 'old@example.com', fullName: 'Old Profile', firstName: 'Old', lastName: 'P' },
    });

    const res = await post('/api/auth/register', { email: 'me@example.com', password: 'a good long password' });
    expect((res.json() as { adoptedExistingProfile: boolean }).adoptedExistingProfile).toBe(true);

    const after = await prisma.profile.findUniqueOrThrow({ where: { id: orphan.id } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'me@example.com' } });
    expect(after.userId).toBe(user.id);
  });

  it('does not adopt anything for the second account', async () => {
    await prisma.profile.create({
      data: { email: 'old@example.com', fullName: 'Old', firstName: 'O', lastName: 'P' },
    });
    await post('/api/auth/register', { email: 'first@example.com', password: 'a good long password' });
    const second = await post('/api/auth/register', { email: 'second@example.com', password: 'a good long password' });
    expect((second.json() as { adoptedExistingProfile: boolean }).adoptedExistingProfile).toBe(false);
  });

  it('refuses a duplicate email and a short password', async () => {
    await post('/api/auth/register', { email: 'dup@example.com', password: 'a good long password' });
    expect((await post('/api/auth/register', { email: 'dup@example.com', password: 'another long one' })).statusCode).toBe(409);
    expect((await post('/api/auth/register', { email: 'new@example.com', password: 'short' })).statusCode).toBe(400);
  });

  it('says the same thing for a wrong password and a missing account', async () => {
    await post('/api/auth/register', { email: 'real@example.com', password: 'a good long password' });

    const wrongPassword = await post('/api/auth/login', { email: 'real@example.com', password: 'not the password' });
    const noSuchUser = await post('/api/auth/login', { email: 'ghost@example.com', password: 'not the password' });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    expect((wrongPassword.json() as { error: string }).error).toBe(
      (noSuchUser.json() as { error: string }).error,
    );
  });

  it('signs in with the right password', async () => {
    await post('/api/auth/register', { email: 'real@example.com', password: 'a good long password' });
    const res = await post('/api/auth/login', { email: 'real@example.com', password: 'a good long password' });
    expect(res.statusCode).toBe(200);
    expect(sessionCookie(res)).toContain(`${SESSION_COOKIE}=`);
  });
});

describe('sessions', () => {
  it('signing out ends the session on the server, not just in the browser', async () => {
    const reg = await post('/api/auth/register', { email: 'x@example.com', password: 'a good long password' });
    const cookie = sessionCookie(reg);
    const token = readCookie(cookie, SESSION_COOKIE)!;

    expect(await currentUser({ headers: { cookie } } as never)).toBeTruthy();

    await post('/api/auth/logout', {}, cookie);

    // The row is gone, so replaying the very same cookie gets nothing. This is
    // the reason the token is opaque rather than self-describing.
    expect(await prisma.session.findUnique({ where: { token } })).toBeNull();
    expect(await currentUser({ headers: { cookie } } as never)).toBeNull();
  });

  it('an expired session is refused and swept up', async () => {
    const reg = await post('/api/auth/register', { email: 'y@example.com', password: 'a good long password' });
    const cookie = sessionCookie(reg);
    const token = readCookie(cookie, SESSION_COOKIE)!;
    await prisma.session.update({ where: { token }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await currentUser({ headers: { cookie } } as never)).toBeNull();
    expect(await prisma.session.findUnique({ where: { token } })).toBeNull();
  });

  it('ignores a made-up token', async () => {
    expect(await currentUser({ headers: { cookie: `${SESSION_COOKIE}=invented` } } as never)).toBeNull();
    expect(await currentUser({ headers: {} } as never)).toBeNull();
  });

  it('reads its cookie out of a header with several', async () => {
    expect(readCookie(`other=1; ${SESSION_COOKIE}=abc; third=2`, SESSION_COOKIE)).toBe('abc');
    expect(readCookie('other=1', SESSION_COOKIE)).toBeNull();
    // A name that merely ends with ours must not match.
    expect(readCookie(`not_${SESSION_COOKIE}=abc`, SESSION_COOKIE)).toBeNull();
  });
});

describe('changing a password', () => {
  it('signs out the other browsers but not this one', async () => {
    const reg = await post('/api/auth/register', { email: 'z@example.com', password: 'a good long password' });
    const here = sessionCookie(reg);
    const elsewhere = sessionCookie(
      await post('/api/auth/login', { email: 'z@example.com', password: 'a good long password' }),
    );

    const res = await post('/api/auth/password', { current: 'a good long password', next: 'a different long one' }, here);
    expect(res.statusCode).toBe(200);

    expect(await currentUser({ headers: { cookie: here } } as never)).toBeTruthy();
    expect(await currentUser({ headers: { cookie: elsewhere } } as never)).toBeNull();

    expect((await post('/api/auth/login', { email: 'z@example.com', password: 'a different long one' })).statusCode).toBe(200);
  });

  it('will not change it without the current one', async () => {
    const cookie = sessionCookie(
      await post('/api/auth/register', { email: 'w@example.com', password: 'a good long password' }),
    );
    expect((await post('/api/auth/password', { current: 'wrong', next: 'a different long one' }, cookie)).statusCode).toBe(401);
    expect((await post('/api/auth/password', { current: 'a good long password', next: 'tiny' }, cookie)).statusCode).toBe(400);
  });
});

describe('password reset', () => {
  it('creates a valid reset token for a user', async () => {
    const user = await prisma.user.create({
      data: { email: 'reset@example.com', passwordHash: await hashPassword('old password') },
    });

    const token = await createPasswordResetToken(user.id);
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    // Token should be stored in database
    const reset = await prisma.passwordReset.findUnique({ where: { token } });
    expect(reset).toBeTruthy();
    expect(reset?.userId).toBe(user.id);
    expect(reset?.usedAt).toBeNull();
  });

  it('invalidates existing tokens when creating a new one', async () => {
    const user = await prisma.user.create({
      data: { email: 'reset@example.com', passwordHash: await hashPassword('old password') },
    });

    const token1 = await createPasswordResetToken(user.id);
    const token2 = await createPasswordResetToken(user.id);

    // First token should no longer be valid
    expect(await validatePasswordResetToken(token1)).toBeNull();
    // Second token should be valid
    expect(await validatePasswordResetToken(token2)).toBe(user.id);
  });

  it('validates a legitimate token', async () => {
    const user = await prisma.user.create({
      data: { email: 'reset@example.com', passwordHash: await hashPassword('old password') },
    });

    const token = await createPasswordResetToken(user.id);
    const userId = await validatePasswordResetToken(token);

    expect(userId).toBe(user.id);
  });

  it('rejects an invalid token', async () => {
    const userId = await validatePasswordResetToken('nonexistent-token');
    expect(userId).toBeNull();
  });

  it('rejects an expired token', async () => {
    const user = await prisma.user.create({
      data: { email: 'reset@example.com', passwordHash: await hashPassword('old password') },
    });

    const token = await createPasswordResetToken(user.id);
    // Manually expire the token
    await prisma.passwordReset.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const userId = await validatePasswordResetToken(token);
    expect(userId).toBeNull();
  });

  it('rejects a used token', async () => {
    const user = await prisma.user.create({
      data: { email: 'reset@example.com', passwordHash: await hashPassword('old password') },
    });

    const token = await createPasswordResetToken(user.id);
    await markPasswordResetTokenUsed(token);

    const userId = await validatePasswordResetToken(token);
    expect(userId).toBeNull();
  });

  it('reset request endpoint always returns success for account enumeration protection', async () => {
    // With existing user
    await prisma.user.create({
      data: { email: 'exists@example.com', passwordHash: await hashPassword('password') },
    });
    const res1 = await post('/api/auth/reset-request', { email: 'exists@example.com' });
    expect(res1.statusCode).toBe(200);

    // With non-existing user - should also return success
    const res2 = await post('/api/auth/reset-request', { email: 'doesnotexist@example.com' });
    expect(res2.statusCode).toBe(200);
  });

  it('reset complete endpoint works with valid token', async () => {
    const user = await prisma.user.create({
      data: { email: 'reset@example.com', passwordHash: await hashPassword('old password') },
    });

    const token = await createPasswordResetToken(user.id);
    const res = await post('/api/auth/reset-complete', { token, password: 'new long password' });

    expect(res.statusCode).toBe(200);

    // Password should be changed
    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await verifyPassword('new long password', updatedUser!.passwordHash)).toBe(true);
    expect(await verifyPassword('old password', updatedUser!.passwordHash)).toBe(false);

    // Token should be marked as used
    const reset = await prisma.passwordReset.findUnique({ where: { token } });
    expect(reset?.usedAt).toBeTruthy();
  });

  it('reset complete endpoint rejects invalid token', async () => {
    const res = await post('/api/auth/reset-complete', { token: 'invalid-token', password: 'new password' });
    expect(res.statusCode).toBe(400);
  });

  it('reset complete endpoint rejects weak password', async () => {
    const user = await prisma.user.create({
      data: { email: 'reset@example.com', passwordHash: await hashPassword('old password') },
    });

    const token = await createPasswordResetToken(user.id);
    const res = await post('/api/auth/reset-complete', { token, password: 'short' });

    expect(res.statusCode).toBe(400);
  });

  it('reset complete endpoint signs out all sessions', async () => {
    const user = await prisma.user.create({
      data: { email: 'reset@example.com', passwordHash: await hashPassword('old password') },
    });

    // Create multiple sessions
    await prisma.session.create({
      data: {
        token: 'session1',
        userId: user.id,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await prisma.session.create({
      data: {
        token: 'session2',
        userId: user.id,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const token = await createPasswordResetToken(user.id);
    await post('/api/auth/reset-complete', { token, password: 'new long password' });

    // All sessions should be deleted
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions.length).toBe(0);
  });
});
