import { beforeEach, describe, expect, it } from 'vitest';

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { registerOverviewRoutes } = await import('../src/routes/overview.js');
const { hashPassword } = await import('../src/auth/passwords.js');
const { createSession, SESSION_COOKIE } = await import('../src/auth/sessions.js');
const Fastify = (await import('fastify')).default;

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  await prisma.applicationEvent.deleteMany({});
  await prisma.pendingQuestion.deleteMany({});
  await prisma.application.deleteMany({});
  await prisma.jobLead.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.interviewRound.deleteMany({});
  await prisma.lesson.deleteMany({});
  await prisma.profile.deleteMany({});
  await prisma.user.deleteMany({});
  app = Fastify();
  registerOverviewRoutes(app);
  await app.ready();
});

const get = (url: string, cookie?: string) =>
  app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

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

describe('overview routes', () => {
  it('scopes application counts to current profile', async () => {
    const { user: user1, cookie: cookie1 } = await createAuthenticatedUser('user1@example.com');
    const { user: user2, cookie: cookie2 } = await createAuthenticatedUser('user2@example.com');

    const profile1 = await createProfileForUser(user1.id);
    const profile2 = await createProfileForUser(user2.id);

    const job = await prisma.job.create({
      data: {
        url: 'https://example.com/job1',
        ats: 'greenhouse',
        company: 'Test Company',
        title: 'Test Job',
      },
    });

    // Create applications for user1
    await prisma.application.create({
      data: {
        profileId: profile1.id,
        jobId: job.id,
        status: 'NEEDS_INPUT',
      },
    });

    await prisma.application.create({
      data: {
        profileId: profile1.id,
        jobId: job.id,
        status: 'SUBMITTED',
      },
    });

    // Create applications for user2
    await prisma.application.create({
      data: {
        profileId: profile2.id,
        jobId: job.id,
        status: 'REVIEW',
      },
    });

    const res1 = await get('/api/overview', cookie1);
    const data1 = res1.json() as { counts: { needsInput: number; submitted: number; inReview: number } };

    expect(data1.counts.needsInput).toBe(1);
    expect(data1.counts.submitted).toBe(1);
    expect(data1.counts.inReview).toBe(0); // Should not see user2's application

    const res2 = await get('/api/overview', cookie2);
    const data2 = res2.json() as { counts: { needsInput: number; submitted: number; inReview: number } };

    expect(data2.counts.needsInput).toBe(0);
    expect(data2.counts.submitted).toBe(0);
    expect(data2.counts.inReview).toBe(1);
  });

  it('scopes interview round counts to current profile', async () => {
    const { user: user1, cookie: cookie1 } = await createAuthenticatedUser('user1@example.com');
    const { user: user2, cookie: cookie2 } = await createAuthenticatedUser('user2@example.com');

    const profile1 = await createProfileForUser(user1.id);
    const profile2 = await createProfileForUser(user2.id);

    const job = await prisma.job.create({
      data: {
        url: 'https://example.com/job1',
        ats: 'greenhouse',
        company: 'Test Company',
        title: 'Test Job',
      },
    });

    const app1 = await prisma.application.create({
      data: { profileId: profile1.id, jobId: job.id, status: 'SUBMITTED' },
    });

    const app2 = await prisma.application.create({
      data: { profileId: profile2.id, jobId: job.id, status: 'SUBMITTED' },
    });

    await prisma.interviewRound.create({
      data: {
        applicationId: app1.id,
        name: 'Technical',
        status: 'SCHEDULED',
      },
    });

    await prisma.interviewRound.create({
      data: {
        applicationId: app2.id,
        name: 'Technical',
        status: 'SCHEDULED',
      },
    });

    const res1 = await get('/api/overview', cookie1);
    const data1 = res1.json() as { counts: { upcomingRounds: number } };

    expect(data1.counts.upcomingRounds).toBe(1);

    const res2 = await get('/api/overview', cookie2);
    const data2 = res2.json() as { counts: { upcomingRounds: number } };

    expect(data2.counts.upcomingRounds).toBe(1);
  });

  it('scopes lesson counts to current profile', async () => {
    const { user: user1, cookie: cookie1 } = await createAuthenticatedUser('user1@example.com');
    const { user: user2, cookie: cookie2 } = await createAuthenticatedUser('user2@example.com');

    const profile1 = await createProfileForUser(user1.id);
    const profile2 = await createProfileForUser(user2.id);

    const job = await prisma.job.create({
      data: {
        url: 'https://example.com/job1',
        ats: 'greenhouse',
        company: 'Test Company',
        title: 'Test Job',
      },
    });

    const app1 = await prisma.application.create({
      data: { profileId: profile1.id, jobId: job.id, status: 'SUBMITTED' },
    });

    const app2 = await prisma.application.create({
      data: { profileId: profile2.id, jobId: job.id, status: 'SUBMITTED' },
    });

    await prisma.lesson.create({
      data: {
        applicationId: app1.id,
        text: 'Lesson for user1',
      },
    });

    await prisma.lesson.create({
      data: {
        applicationId: app2.id,
        text: 'Lesson for user2',
      },
    });

    const res1 = await get('/api/overview', cookie1);
    const data1 = res1.json() as { counts: { lessons: number } };

    expect(data1.counts.lessons).toBe(1);

    const res2 = await get('/api/overview', cookie2);
    const data2 = res2.json() as { counts: { lessons: number } };

    expect(data2.counts.lessons).toBe(1);
  });

  it('scopes shortlisted lead counts to current profile', async () => {
    const { user: user1, cookie: cookie1 } = await createAuthenticatedUser('user1@example.com');
    const { user: user2, cookie: cookie2 } = await createAuthenticatedUser('user2@example.com');

    const profile1 = await createProfileForUser(user1.id);
    const profile2 = await createProfileForUser(user2.id);

    await prisma.jobLead.create({
      data: {
        profileId: profile1.id,
        url: 'https://example.com/job1',
        ats: 'greenhouse',
        title: 'Job 1',
        companyName: 'Company A',
        status: 'SHORTLISTED',
      },
    });

    await prisma.jobLead.create({
      data: {
        profileId: profile2.id,
        url: 'https://example.com/job2',
        ats: 'greenhouse',
        title: 'Job 2',
        companyName: 'Company B',
        status: 'SHORTLISTED',
      },
    });

    const res1 = await get('/api/overview', cookie1);
    const data1 = res1.json() as { counts: { shortlisted: number } };

    expect(data1.counts.shortlisted).toBe(1);

    const res2 = await get('/api/overview', cookie2);
    const data2 = res2.json() as { counts: { shortlisted: number } };

    expect(data2.counts.shortlisted).toBe(1);
  });

  it('scopes runs in flight counts to current profile', async () => {
    const { user: user1, cookie: cookie1 } = await createAuthenticatedUser('user1@example.com');
    const { user: user2, cookie: cookie2 } = await createAuthenticatedUser('user2@example.com');

    const profile1 = await createProfileForUser(user1.id);
    const profile2 = await createProfileForUser(user2.id);

    const job = await prisma.job.create({
      data: {
        url: 'https://example.com/job1',
        ats: 'greenhouse',
        company: 'Test Company',
        title: 'Test Job',
      },
    });

    await prisma.application.create({
      data: {
        profileId: profile1.id,
        jobId: job.id,
        status: 'FILLING',
        updatedAt: new Date(),
      },
    });

    await prisma.application.create({
      data: {
        profileId: profile2.id,
        jobId: job.id,
        status: 'PREPARING',
        updatedAt: new Date(),
      },
    });

    const res1 = await get('/api/overview', cookie1);
    const data1 = res1.json() as { counts: { runsInFlight: number } };

    expect(data1.counts.runsInFlight).toBe(1);

    const res2 = await get('/api/overview', cookie2);
    const data2 = res2.json() as { counts: { runsInFlight: number } };

    expect(data2.counts.runsInFlight).toBe(1);
  });

  it('scopes urgent application to current profile', async () => {
    const { user: user1, cookie: cookie1 } = await createAuthenticatedUser('user1@example.com');
    const { user: user2, cookie: cookie2 } = await createAuthenticatedUser('user2@example.com');

    const profile1 = await createProfileForUser(user1.id);
    const profile2 = await createProfileForUser(user2.id);

    const job1 = await prisma.job.create({
      data: {
        url: 'https://example.com/job1',
        ats: 'greenhouse',
        company: 'Company A',
        title: 'Job A',
      },
    });

    const job2 = await prisma.job.create({
      data: {
        url: 'https://example.com/job2',
        ats: 'greenhouse',
        company: 'Company B',
        title: 'Job B',
      },
    });

    await prisma.application.create({
      data: {
        profileId: profile1.id,
        jobId: job1.id,
        status: 'NEEDS_INPUT',
        blockedReason: 'Missing info',
      },
    });

    await prisma.application.create({
      data: {
        profileId: profile2.id,
        jobId: job2.id,
        status: 'REVIEW',
      },
    });

    const res1 = await get('/api/overview', cookie1);
    const data1 = res1.json() as { needsYou: { first: { company: string } | null } };

    expect(data1.needsYou.first).toBeTruthy();
    expect(data1.needsYou.first?.company).toBe('Company A');

    const res2 = await get('/api/overview', cookie2);
    const data2 = res2.json() as { needsYou: { first: { company: string } | null } };

    expect(data2.needsYou.first).toBeTruthy();
    expect(data2.needsYou.first?.company).toBe('Company B');
  });

  it('returns zero counts for user with no profile', async () => {
    const { cookie } = await createAuthenticatedUser('noprofile@example.com');

    const res = await get('/api/overview', cookie);
    const data = res.json() as { counts: { needsInput: number; submitted: number; lessons: number } };

    expect(data.counts.needsInput).toBe(0);
    expect(data.counts.submitted).toBe(0);
    expect(data.counts.lessons).toBe(0);
  });

  it('requires authentication for system endpoint', async () => {
    const res = await get('/api/system');
    expect(res.statusCode).toBe(401);
  });

  it('returns system info for authenticated user', async () => {
    const { cookie } = await createAuthenticatedUser('test@example.com');

    const res = await get('/api/system', cookie);
    expect(res.statusCode).toBe(200);
  });
});
