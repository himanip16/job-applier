import { beforeEach, describe, expect, it } from 'vitest';

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { registerFactsRoutes } = await import('../src/routes/facts.js');
const { hashPassword } = await import('../src/auth/passwords.js');
const { createSession, SESSION_COOKIE } = await import('../src/auth/sessions.js');
const Fastify = (await import('fastify')).default;

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  await prisma.profileFact.deleteMany({});
  await prisma.profile.deleteMany({});
  await prisma.user.deleteMany({});
  app = Fastify();
  registerFactsRoutes(app, await app);
  await app.ready();
});

const post = (url: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });

const del = (url: string, cookie?: string) =>
  app.inject({ method: 'DELETE', url, headers: cookie ? { cookie } : {} });

function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers['set-cookie'] ?? '');
  const value = raw.split(';')[0] ?? '';
  return value;
}

async function createAuthenticatedUser(email: string) {
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword('a good long password') },
  });
  const { token } = await createSession(user.id, 'test-agent');
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

async function createProfileForUser(userId: string) {
  return prisma.profile.create({
    data: {
      userId,
      email: 'profile@example.com',
      fullName: 'Profile User',
      firstName: 'Profile',
      lastName: 'User',
    },
  });
}

describe('facts routes', () => {
  it('creates a fact with valid input', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    const profile = await createProfileForUser(user.id);

    const res = await post('/api/facts', {
      key: 'work_authorization.us',
      label: 'Are you authorized to work in the US?',
      value: 'Yes',
      kind: 'TEXT',
    }, cookie);

    expect(res.statusCode).toBe(200);

    const fact = await prisma.profileFact.findUnique({
      where: { profileId_key: { profileId: profile.id, key: 'work_authorization.us' } },
    });

    expect(fact).toBeTruthy();
    expect(fact?.value).toBe('Yes');
  });

  it('updates existing fact with same key', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    const profile = await createProfileForUser(user.id);

    await prisma.profileFact.create({
      data: {
        profileId: profile.id,
        key: 'work_authorization.us',
        label: 'Old label',
        value: 'Old value',
        kind: 'TEXT',
      },
    });

    const res = await post('/api/facts', {
      key: 'work_authorization.us',
      label: 'New label',
      value: 'New value',
      kind: 'TEXT',
    }, cookie);

    expect(res.statusCode).toBe(200);

    const fact = await prisma.profileFact.findUnique({
      where: { profileId_key: { profileId: profile.id, key: 'work_authorization.us' } },
    });

    expect(fact?.label).toBe('New label');
    expect(fact?.value).toBe('New value');
  });

  it('rejects whitespace-only key with 400', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/facts', {
      key: '   ',
      label: 'Test',
      value: 'Test',
    }, cookie);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid input');
  });

  it('rejects whitespace-only label with 400', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/facts', {
      key: 'test_key',
      label: '   ',
      value: 'Test',
    }, cookie);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid input');
  });

  it('rejects key exceeding max length with 400', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/facts', {
      key: 'a'.repeat(101),
      label: 'Test',
      value: 'Test',
    }, cookie);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid input');
  });

  it('rejects label exceeding max length with 400', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/facts', {
      key: 'test_key',
      label: 'a'.repeat(201),
      value: 'Test',
    }, cookie);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid input');
  });

  it('rejects value exceeding max length with 400', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/facts', {
      key: 'test_key',
      label: 'Test',
      value: 'a'.repeat(5001),
    }, cookie);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid input');
  });

  it('accepts key and label at max length', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    const profile = await createProfileForUser(user.id);

    const res = await post('/api/facts', {
      key: 'a'.repeat(100),
      label: 'a'.repeat(200),
      value: 'Test',
    }, cookie);

    expect(res.statusCode).toBe(200);
  });

  it('trims whitespace from key and label', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    const profile = await createProfileForUser(user.id);

    const res = await post('/api/facts', {
      key: '  test_key  ',
      label: '  Test Label  ',
      value: 'Test',
    }, cookie);

    expect(res.statusCode).toBe(200);

    const fact = await prisma.profileFact.findUnique({
      where: { profileId_key: { profileId: profile.id, key: 'test_key' } },
    });

    expect(fact?.key).toBe('test_key');
    expect(fact?.label).toBe('Test Label');
  });

  it('rejects invalid kind with 400', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/facts', {
      key: 'test_key',
      label: 'Test',
      value: 'Test',
      kind: 'INVALID_KIND',
    }, cookie);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid input');
  });

  it('defaults kind to TEXT when not provided', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    const profile = await createProfileForUser(user.id);

    const res = await post('/api/facts', {
      key: 'test_key',
      label: 'Test',
      value: 'Test',
    }, cookie);

    expect(res.statusCode).toBe(200);

    const fact = await prisma.profileFact.findUnique({
      where: { profileId_key: { profileId: profile.id, key: 'test_key' } },
    });

    expect(fact?.kind).toBe('TEXT');
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await post('/api/facts', {
      key: 'test_key',
      label: 'Test',
      value: 'Test',
    });

    expect(res.statusCode).toBe(401);
  });

  it('deletes fact owned by current user', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    const profile = await createProfileForUser(user.id);

    const fact = await prisma.profileFact.create({
      data: {
        profileId: profile.id,
        key: 'test_key',
        label: 'Test',
        value: 'Test',
        kind: 'TEXT',
      },
    });

    const res = await del(`/api/facts/${fact.id}`, cookie);
    expect(res.statusCode).toBe(200);

    const deleted = await prisma.profileFact.findUnique({ where: { id: fact.id } });
    expect(deleted).toBeNull();
  });

  it('rejects deletion of fact owned by another user', async () => {
    const { user: user1, cookie: cookie1 } = await createAuthenticatedUser('user1@example.com');
    const { user: user2, cookie: cookie2 } = await createAuthenticatedUser('user2@example.com');

    const profile1 = await createProfileForUser(user1.id);
    const profile2 = await createProfileForUser(user2.id);

    const fact = await prisma.profileFact.create({
      data: {
        profileId: profile1.id,
        key: 'test_key',
        label: 'Test',
        value: 'Test',
        kind: 'TEXT',
      },
    });

    const res = await del(`/api/facts/${fact.id}`, cookie2);
    expect(res.statusCode).toBe(404);

    // Fact should still exist
    const stillExists = await prisma.profileFact.findUnique({ where: { id: fact.id } });
    expect(stillExists).toBeTruthy();
  });

  it('returns 401 for unauthenticated delete requests', async () => {
    const res = await del('/api/facts/some-id');
    expect(res.statusCode).toBe(401);
  });
});
