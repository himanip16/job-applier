import { beforeEach, describe, expect, it } from 'vitest';

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { registerProfileRoutes } = await import('../src/routes/profile.js');
const { hashPassword } = await import('../src/auth/passwords.js');
const { createSession, SESSION_COOKIE } = await import('../src/auth/sessions.js');
const Fastify = (await import('fastify')).default;

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  await prisma.profile.deleteMany({});
  await prisma.user.deleteMany({});
  app = Fastify();
  registerProfileRoutes(app, await app);
  await app.ready();
});

const post = (url: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'PUT', url, payload, headers: cookie ? { cookie } : {} });

const get = (url: string, cookie?: string) =>
  app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

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

describe('profile routes', () => {
  it('creates a profile and syncs email to user', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/profile', {
      email: 'newemail@example.com',
      fullName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
    }, cookie);

    expect(res.statusCode).toBe(200);

    // Profile should be created with new email
    const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
    expect(profile?.email).toBe('newemail@example.com');

    // User email should be synced
    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updatedUser?.email).toBe('newemail@example.com');
  });

  it('updates existing profile and syncs email to user', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    
    await prisma.profile.create({
      data: {
        userId: user.id,
        email: 'old@example.com',
        fullName: 'Old Name',
        firstName: 'Old',
        lastName: 'Name',
      },
    });

    const res = await post('/api/profile', {
      email: 'updated@example.com',
      fullName: 'Updated Name',
      firstName: 'Updated',
      lastName: 'Name',
    }, cookie);

    expect(res.statusCode).toBe(200);

    // Profile email should be updated
    const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
    expect(profile?.email).toBe('updated@example.com');

    // User email should be synced
    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updatedUser?.email).toBe('updated@example.com');
  });

  it('rejects invalid email format with 400', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/profile', {
      email: 'not-an-email',
      fullName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
    }, cookie);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid input');
  });

  it('rejects empty strings in optional fields with 400', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/profile', {
      email: 'test@example.com',
      fullName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
      phone: '   ',  // whitespace only
      city: '',      // empty string
    }, cookie);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid input');
  });

  it('rejects invalid URLs with 400', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/profile', {
      email: 'test@example.com',
      fullName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
      linkedin: 'not-a-url',
      github: 'also-not-a-url',
    }, cookie);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('Invalid input');
  });

  it('accepts valid URLs in optional fields', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await post('/api/profile', {
      email: 'test@example.com',
      fullName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
      linkedin: 'https://linkedin.com/in/test',
      github: 'https://github.com/test',
      website: 'https://example.com',
      portfolio: 'https://portfolio.example.com',
    }, cookie);

    expect(res.statusCode).toBe(200);
  });

  it('handles profile creation race condition with upsert', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');

    // Create profile directly
    await prisma.profile.create({
      data: {
        userId: user.id,
        email: 'first@example.com',
        fullName: 'First',
        firstName: 'F',
        lastName: 'I',
      },
    });

    // Try to create again via API - should update instead of error
    const res = await post('/api/profile', {
      email: 'second@example.com',
      fullName: 'Second',
      firstName: 'S',
      lastName: 'E',
    }, cookie);

    expect(res.statusCode).toBe(200);

    // Should have updated, not created duplicate
    const profiles = await prisma.profile.findMany({ where: { userId: user.id } });
    expect(profiles.length).toBe(1);
    expect(profiles[0]?.email).toBe('second@example.com');
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await post('/api/profile', {
      email: 'test@example.com',
      fullName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for unauthenticated GET requests', async () => {
    const res = await get('/api/profile');
    expect(res.statusCode).toBe(401);
  });

  it('returns profile for authenticated user', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');

    await prisma.profile.create({
      data: {
        userId: user.id,
        email: 'profile@example.com',
        fullName: 'Profile User',
        firstName: 'Profile',
        lastName: 'User',
      },
    });

    const res = await get('/api/profile', cookie);
    expect(res.statusCode).toBe(200);

    const data = res.json() as { profile: { email: string } };
    expect(data.profile.email).toBe('profile@example.com');
  });
});
