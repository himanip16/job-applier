import { beforeEach, describe, expect, it } from 'vitest';

/**
 * One signed-in person must not reach another's rows.
 *
 * Authentication and authorisation are different jobs and the app had only
 * the first: every route addressed by id fetched the row and trusted it, so
 * a second account with a guessed id could read someone's applications,
 * interview notes and answer bank.
 *
 * This suite is written as a table on purpose. A per-route assertion catches
 * the routes that existed when it was written; a table that every id-addressed
 * route has to appear in catches the next one somebody adds.
 */

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { registerDiscoveryRoutes } = await import('../src/routes/discovery.js');
const { registerTrackerRoutes } = await import('../src/routes/tracker.js');
const { registerResumeRoutes } = await import('../src/routes/resume.js');
const { registerJobDetailRoutes } = await import('../src/routes/jobDetail.js');
const Fastify = (await import('fastify')).default;

let app: ReturnType<typeof Fastify>;
/** Everything below belongs to Mallory; every request is made as Alice. */
let alice: string;
let theirs: Record<string, string>;

beforeEach(async () => {
  for (const table of [
    prisma.interviewQuestion,
    prisma.interviewRound,
    prisma.lesson,
    prisma.tailoredResume,
    prisma.resumeFile,
    prisma.answer,
    prisma.jobLead,
    prisma.application,
    prisma.job,
    prisma.preferenceSignal,
    prisma.profileFact,
    prisma.profile,
  ]) {
    await (table as { deleteMany: (a: object) => Promise<unknown> }).deleteMany({});
  }

  const mk = async (email: string) =>
    (await prisma.profile.create({
      data: { email, fullName: 'X Y', firstName: 'X', lastName: 'Y' },
    })).id;
  alice = await mk(`alice-${Date.now()}@example.com`);
  const mallory = await mk(`mallory-${Date.now()}@example.com`);

  const job = await prisma.job.create({
    data: { url: `https://boards.greenhouse.io/acme/jobs/${Date.now()}`, ats: 'greenhouse', company: 'Acme', title: 'Engineer' },
  });
  const application = await prisma.application.create({
    data: { profileId: mallory, jobId: job.id },
  });
  const lead = await prisma.jobLead.create({
    data: {
      profileId: mallory,
      url: job.url,
      ats: 'greenhouse',
      title: 'Engineer',
      companyName: 'Acme',
      descriptionText: 'Private.',
    },
  });
  const round = await prisma.interviewRound.create({
    data: { applicationId: application.id, name: 'Screen', sequence: 0 },
  });
  const question = await prisma.interviewQuestion.create({
    data: { roundId: round.id, question: 'Why us?' },
  });
  const lesson = await prisma.lesson.create({
    data: { applicationId: application.id, text: 'Prepare better.' },
  });
  const signal = await prisma.preferenceSignal.create({
    data: { profileId: mallory, term: 'php', weight: -1, origin: 'LEXICAL' },
  });
  const fact = await prisma.profileFact.create({
    data: { profileId: mallory, key: 'visa.us', label: 'Visa', value: 'No' },
  });
  const baseResume = await prisma.resumeFile.create({
    data: {
      profileId: mallory,
      label: 'Default',
      filename: 'r.pdf',
      mimeType: 'application/pdf',
      path: '/tmp/r.pdf',
      bytes: 1,
    },
  });
  const tailored = await prisma.tailoredResume.create({
    data: {
      profileId: mallory,
      jobId: job.id,
      baseResumeId: baseResume.id,
      label: 'T',
      text: 'secret resume',
      insertions: [],
      unsupported: [],
      covered: [],
    },
  });

  theirs = {
    application: application.id,
    lead: lead.id,
    round: round.id,
    question: question.id,
    lesson: lesson.id,
    signal: signal.id,
    fact: fact.id,
    tailored: tailored.id,
  };

  app = Fastify();
  // Signed in as Alice, throughout.
  const asAlice = async () => ({ id: alice });
  registerDiscoveryRoutes(app, asAlice);
  registerTrackerRoutes(app, asAlice);
  registerResumeRoutes(app, asAlice);
  registerJobDetailRoutes(app, asAlice);
  await app.ready();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Every route that takes an id someone else could own.
 *
 * Adding a route addressed by id means adding a row here. That is the point:
 * the list is the checklist.
 */
const ROUTES: [Method, (t: Record<string, string>) => string, unknown?][] = [
  ['GET', (t) => `/api/jobs/${t.application}`],
  ['GET', (t) => `/api/jobs/${t.lead}`],
  ['GET', (t) => `/api/leads/${t.lead}`],
  ['POST', (t) => `/api/leads/${t.lead}/rescore`],
  ['POST', (t) => `/api/leads/${t.lead}/reject`, {}],
  ['POST', (t) => `/api/leads/${t.lead}/shortlist`],
  ['POST', (t) => `/api/leads/${t.lead}/apply`, {}],
  ['DELETE', (t) => `/api/preferences/${t.signal}`],
  ['PATCH', (t) => `/api/tracker/${t.application}`, { notes: 'mine now' }],
  ['POST', (t) => `/api/tracker/${t.application}/rounds`, { name: 'Injected' }],
  ['POST', (t) => `/api/tracker/${t.application}/lessons`, { text: 'Injected' }],
  ['PATCH', (t) => `/api/rounds/${t.round}`, { notes: 'peeking' }],
  ['DELETE', (t) => `/api/rounds/${t.round}`],
  ['POST', (t) => `/api/rounds/${t.round}/questions`, { question: 'Injected' }],
  ['PATCH', (t) => `/api/questions/${t.question}`, { myAnswer: 'peeking' }],
  ['DELETE', (t) => `/api/questions/${t.question}`],
  ['DELETE', (t) => `/api/lessons/${t.lesson}`],
  ['GET', (t) => `/api/resume/tailored/${t.tailored}`],
  ['POST', (t) => `/api/tracker/${t.application}/resume`, { tailoredResumeId: 'x' }],
];

describe("another person's rows", () => {
  for (const [method, url, payload] of ROUTES) {
    it(`${method} ${url({ application: ':application', lead: ':lead', round: ':round', question: ':question', lesson: ':lesson', signal: ':signal', fact: ':fact', tailored: ':tailored' })} is not found`, async () => {
      const res = await app.inject({ method, url: url(theirs), payload: payload as never });
      // 404, never 403: a 403 confirms the id exists, which is the one thing
      // worth not confirming.
      expect(res.statusCode).toBe(404);
    });
  }

  it('leaves the rows untouched after all of that', async () => {
    for (const [method, url, payload] of ROUTES) {
      await app.inject({ method, url: url(theirs), payload: payload as never });
    }
    expect(await prisma.interviewRound.findUnique({ where: { id: theirs.round! } })).toBeTruthy();
    expect(await prisma.interviewQuestion.findUnique({ where: { id: theirs.question! } })).toBeTruthy();
    expect(await prisma.lesson.findUnique({ where: { id: theirs.lesson! } })).toBeTruthy();
    expect(await prisma.preferenceSignal.findUnique({ where: { id: theirs.signal! } })).toBeTruthy();

    const lead = await prisma.jobLead.findUnique({ where: { id: theirs.lead! } });
    expect(lead?.status).toBe('NEW');

    const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: theirs.round! } });
    expect(round.notes).toBeNull();
    expect(await prisma.interviewQuestion.count({ where: { roundId: theirs.round! } })).toBe(1);
  });

  it('still lets the owner through', async () => {
    // The lock is not simply "refuse everything".
    const mine = await prisma.jobLead.create({
      data: {
        profileId: alice,
        url: `https://boards.greenhouse.io/acme/jobs/mine-${Date.now()}`,
        ats: 'greenhouse',
        title: 'Engineer',
        companyName: 'Acme',
      },
    });
    const res = await app.inject({ method: 'GET', url: `/api/leads/${mine.id}` });
    expect(res.statusCode).toBe(200);
  });
});

describe('marking a lead as applied by hand', () => {
  it('records it in the tracker and takes it out of the queue', async () => {
    const lead = await prisma.jobLead.create({
      data: {
        profileId: alice,
        url: `https://boards.greenhouse.io/acme/jobs/byhand-${Date.now()}`,
        ats: 'greenhouse',
        title: 'Backend Engineer',
        companyName: 'Acme',
        descriptionText: 'Go and Postgres.',
      },
    });

    const res = await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/applied` });
    expect(res.statusCode).toBe(200);
    const { applicationId } = res.json() as { applicationId: string };

    const after = await prisma.jobLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('APPLIED');
    expect(after.applicationId).toBe(applicationId);

    // SUBMITTED, because it was - the tracker hangs rounds and outcomes off
    // this row exactly as it does for a run the automation drove.
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    expect(application.status).toBe('SUBMITTED');
    expect(application.outcome).toBe('IN_PROGRESS');
    expect(application.submittedAt).toBeTruthy();
  });

  it('does not overwrite what a real run recorded', async () => {
    const job = await prisma.job.create({
      data: { url: `https://boards.greenhouse.io/acme/jobs/ran-${Date.now()}`, ats: 'greenhouse', company: 'Acme', title: 'Engineer' },
    });
    const ran = await prisma.application.create({
      data: { profileId: alice, jobId: job.id, status: 'SUBMITTED', confirmation: 'Thanks for applying' },
    });
    const lead = await prisma.jobLead.create({
      data: { profileId: alice, url: job.url, ats: 'greenhouse', title: 'Engineer', companyName: 'Acme' },
    });

    await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/applied` });

    const after = await prisma.application.findUniqueOrThrow({ where: { id: ran.id } });
    expect(after.confirmation).toBe('Thanks for applying');
  });

  it('will not mark someone else’s lead', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/leads/${theirs.lead}/applied` });
    expect(res.statusCode).toBe(404);
    const lead = await prisma.jobLead.findUniqueOrThrow({ where: { id: theirs.lead! } });
    expect(lead.status).toBe('NEW');
  });
});
