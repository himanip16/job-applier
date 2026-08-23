import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Two things added because the app was unusable without them.
 *
 * Keys had to be typed into a dotfile and the server restarted, which meant
 * the most common failure ("nothing happens when I press the button") had its
 * fix hidden in a file nobody opens. And the job everything else describes had
 * no page of its own, so its state was spread across five.
 */

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { loadSettings, setSetting, clearSetting, secret, secretOrigin, maskSecret } = await import(
  '../src/lib/secrets.js'
);
const { config } = await import('../src/lib/config.js');
const { registerJobDetailRoutes } = await import('../src/routes/jobDetail.js');
const Fastify = (await import('fastify')).default;

describe('keys saved from the UI', () => {
  beforeEach(async () => {
    await prisma.setting.deleteMany({});
    delete process.env.FIRECRAWL_API_KEY;
    await loadSettings();
  });

  it('takes effect immediately, without a restart', async () => {
    // The whole point. config.firecrawlApiKey is read on hot paths as a plain
    // property, so it is a getter over this cache rather than a constant read
    // once at import.
    expect(config.firecrawlApiKey).toBe('');
    await setSetting('FIRECRAWL_API_KEY', 'fc-live-abc123');
    expect(config.firecrawlApiKey).toBe('fc-live-abc123');
  });

  it('survives a restart', async () => {
    await setSetting('FIRECRAWL_API_KEY', 'fc-live-abc123');
    // Simulate a fresh process: the cache is rebuilt from the database.
    await loadSettings();
    expect(config.firecrawlApiKey).toBe('fc-live-abc123');
  });

  it('prefers a saved key over one in the environment, and says which is in force', async () => {
    process.env.FIRECRAWL_API_KEY = 'from-dotenv';
    await loadSettings();
    expect(secretOrigin('FIRECRAWL_API_KEY')).toBe('env');
    expect(config.firecrawlApiKey).toBe('from-dotenv');

    await setSetting('FIRECRAWL_API_KEY', 'from-the-ui');
    expect(secretOrigin('FIRECRAWL_API_KEY')).toBe('saved');
    expect(config.firecrawlApiKey).toBe('from-the-ui');
  });

  it('lets the .env value show through again when the saved one is cleared', async () => {
    // Clearing a key you typed here must not also disable one that was already
    // working from .env - that would be a confusing way to lose a feature.
    process.env.FIRECRAWL_API_KEY = 'from-dotenv';
    await loadSettings();
    await setSetting('FIRECRAWL_API_KEY', 'from-the-ui');
    await clearSetting('FIRECRAWL_API_KEY');
    expect(config.firecrawlApiKey).toBe('from-dotenv');
    expect(secretOrigin('FIRECRAWL_API_KEY')).toBe('env');
  });

  it('treats an empty value as clearing rather than storing a blank key', async () => {
    await setSetting('FIRECRAWL_API_KEY', 'fc-live-abc123');
    await setSetting('FIRECRAWL_API_KEY', '   ');
    expect(config.firecrawlApiKey).toBe('');
    expect(await prisma.setting.count({ where: { key: 'FIRECRAWL_API_KEY' } })).toBe(0);
  });

  it('shows enough of a key to recognise and not enough to use', () => {
    expect(maskSecret('fc-abcdefghijklmnop')).toBe('fc-a••••mnop');
    expect(maskSecret('fc-abcdefghijklmnop')).not.toContain('efghijkl');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret('')).toBe('');
  });

  it('falls back to GOOGLE_API_KEY, which is what Google calls it', async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'goog-123';
    await loadSettings();
    expect(secret('GEMINI_API_KEY', 'GOOGLE_API_KEY')).toBe('goog-123');
    delete process.env.GOOGLE_API_KEY;
  });
});

describe('one job, everything about it', () => {
  let app: ReturnType<typeof Fastify>;
  let profileId: string;

  beforeEach(async () => {
    await prisma.jobLead.deleteMany({});
    await prisma.application.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.profile.deleteMany({});
    const p = await prisma.profile.create({
      data: {
        email: `detail-${Date.now()}@example.com`,
        fullName: 'Test Person',
        firstName: 'Test',
        lastName: 'Person',
      },
    });
    profileId = p.id;

    app = Fastify();
    registerJobDetailRoutes(app);
    await app.ready();
  });

  const get = async (id: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${id}` });
    return { status: res.statusCode, body: res.json() as Record<string, never> };
  };

  it('answers for a lead that has never been applied to', async () => {
    const lead = await prisma.jobLead.create({
      data: {
        profileId,
        url: 'https://job-boards.greenhouse.io/acme/jobs/1',
        ats: 'greenhouse',
        title: 'Senior Backend Engineer',
        companyName: 'Acme Corp',
        location: 'San Francisco, CA',
        score: 91,
        deepScored: true,
        scoreReasons: {
          verdict: 'STRONG',
          seniorityFit: 'MATCH',
          forIt: ['Java', 'Distributed systems', 'Kafka'],
          againstIt: ['Kubernetes — limited evidence'],
        },
      },
    });

    const { status, body } = await get(lead.id);
    expect(status).toBe(200);
    expect(body.job).toMatchObject({ title: 'Senior Backend Engineer', company: 'Acme Corp' });
    expect(body.match).toMatchObject({ score: 91, verdict: 'STRONG' });
    expect((body.match as never as { forIt: string[] }).forIt).toContain('Kafka');
    expect(body.application).toBeNull();
    // The one question the page exists to answer.
    expect(body.nextAction).toMatchObject({ label: 'Triage this lead' });
  });

  it('joins the lead to its application and reports where each answer came from', async () => {
    const job = await prisma.job.create({
      data: {
        url: 'https://job-boards.greenhouse.io/acme/jobs/2',
        ats: 'greenhouse',
        company: 'Acme Corp',
        title: 'Staff Engineer',
      },
    });
    const application = await prisma.application.create({
      data: {
        profileId,
        jobId: job.id,
        status: 'REVIEW',
        coverLetter: 'Dear Acme, '.repeat(40),
        fieldPlan: [
          { label: 'First name', source: 'PROFILE', filled: true },
          { label: 'Email', source: 'PROFILE', filled: true },
          { label: 'Work auth', source: 'RULE', filled: true },
          { label: 'Notice period', source: 'MEMORY', filled: true },
          { label: 'Why us?', source: 'GENERATED', filled: true },
          { label: 'Referred by', source: 'SKIPPED', filled: false },
          { label: 'Portfolio', source: 'PROFILE', filled: false, error: 'field disappeared' },
        ],
      },
    });
    const lead = await prisma.jobLead.create({
      data: {
        profileId,
        url: job.url,
        ats: 'greenhouse',
        title: 'Staff Engineer',
        companyName: 'Acme Corp',
        status: 'APPLIED',
        applicationId: application.id,
        score: 80,
      },
    });
    await prisma.pendingQuestion.create({
      data: {
        applicationId: application.id,
        fieldId: 'f1',
        fieldSelector: '#f1',
        rawLabel: 'Salary expectation?',
        fieldKind: 'TEXT',
        reason: 'NO_MATCH',
      },
    });

    const { body } = await get(lead.id);
    const f = (body.application as never as { fields: Record<string, number> }).fields;
    expect(f.total).toBe(7);
    expect(f.fromProfile).toBe(4); // 3 PROFILE + 1 RULE
    expect(f.fromMemory).toBe(1);
    expect(f.written).toBe(1);
    expect(f.skipped).toBe(1);
    expect(f.failed).toBe(1);
    // The unanswered popup is the thing blocking this application.
    expect(f.needsYou).toBe(1);
    expect(body.nextAction).toMatchObject({ label: 'Review and submit', urgent: true });
  });

  it('is reachable by application id too, not just lead id', async () => {
    const job = await prisma.job.create({
      data: { url: 'https://jobs.lever.co/acme/3', ats: 'lever', company: 'Acme', title: 'Engineer' },
    });
    const application = await prisma.application.create({
      data: { profileId, jobId: job.id, status: 'SUBMITTED', submittedAt: new Date() },
    });

    // A link from the runs page carries this id; the caller should not have to
    // know which kind of id it is holding.
    const { status, body } = await get(application.id);
    expect(status).toBe(200);
    expect(body.job).toMatchObject({ title: 'Engineer' });
    expect(body.application).toMatchObject({ id: application.id, status: 'SUBMITTED' });
  });

  it('still joins when the lead and the job URL differ only by scheme', async () => {
    // Leads from search arrive over http; a job created from a pasted URL is
    // https. Failing this join would show an applied job as never started.
    const job = await prisma.job.create({
      data: {
        url: 'https://job-boards.greenhouse.io/acme/jobs/4',
        ats: 'greenhouse',
        company: 'Acme',
        title: 'Engineer',
      },
    });
    const application = await prisma.application.create({
      data: { profileId, jobId: job.id, status: 'FILLING' },
    });
    const lead = await prisma.jobLead.create({
      data: {
        profileId,
        url: 'http://job-boards.greenhouse.io/acme/jobs/4',
        ats: 'greenhouse',
        title: 'Engineer',
        companyName: 'Acme',
        score: 50,
      },
    });

    const { body } = await get(lead.id);
    expect(body.application).toMatchObject({ id: application.id });
    expect(body.nextAction).toMatchObject({ label: 'Watch it run' });
  });

  it('brings the interview rounds and lessons onto the same page', async () => {
    const job = await prisma.job.create({
      data: { url: 'https://jobs.lever.co/acme/5', ats: 'lever', company: 'Acme', title: 'Engineer' },
    });
    const application = await prisma.application.create({
      data: { profileId, jobId: job.id, status: 'SUBMITTED', outcome: 'IN_PROGRESS' },
    });
    const round = await prisma.interviewRound.create({
      data: { applicationId: application.id, name: 'Coding', sequence: 1, status: 'PASSED' },
    });
    await prisma.interviewQuestion.create({
      data: { roundId: round.id, question: 'Reverse a linked list', selfRating: 'GOOD' },
    });
    await prisma.lesson.create({
      data: { applicationId: application.id, text: 'Should have asked about scale first' },
    });

    const { body } = await get(application.id);
    const rounds = body.rounds as never as { name: string; questions: { question: string }[] }[];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.name).toBe('Coding');
    expect(rounds[0]!.questions[0]!.question).toBe('Reverse a linked list');
    expect(body.lessons).toHaveLength(1);
  });

  it('404s on an id that is neither, rather than rendering an empty page', async () => {
    const { status } = await get('does-not-exist');
    expect(status).toBe(404);
  });
});
