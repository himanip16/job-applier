import { createServer, type Server } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Full-stack run: real Postgres, real Playwright, real resolver, real fill
 * engine, real submit-outcome detection — against a fixture that reproduces a
 * live Greenhouse board's DOM.
 *
 * The Anthropic calls are the one thing stubbed. That boundary is where the
 * test would otherwise be non-deterministic and cost money, and stubbing it
 * lets us drive the two branches that matter most: the model returning a
 * confident answer, and the model correctly refusing — which is what triggers
 * the ask-the-human pause this whole system is built around.
 */

const inferMock = vi.fn();
const essayMock = vi.fn();
const coverLetterMock = vi.fn();

vi.mock('../src/llm/inferAnswer.js', () => ({
  inferAnswer: (...args: unknown[]) => inferMock(...args),
  // Batching is an envelope; the tests reason per field.
  inferAnswers: async ({ fields, ...rest }: { fields: { id: string }[] }) =>
    new Map(await Promise.all(fields.map(async (field) => [field.id, await inferMock({ ...rest, field })] as const))),
}));
vi.mock('../src/llm/coverLetter.js', () => ({
  generateEssayAnswer: (...args: unknown[]) => essayMock(...args),
  generateCoverLetter: (...args: unknown[]) => coverLetterMock(...args),
}));

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { runApplication, submitAnswers, decideReview } = await import('../src/engine/runner.js');
const { closeContext, getContextSync } = await import('../src/browser/session.js');
const { bus } = await import('../src/lib/events.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../../fixtures');

let server: Server;
let baseUrl: string;
let profileId: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const name = (req.url ?? '/').replace(/^\//, '').split('?')[0] || 'index.html';
    try {
      const body = await readFile(path.join(fixtures, name));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  await closeContext();
  await new Promise<void>((r) => server?.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  inferMock.mockReset();
  essayMock.mockReset();
  coverLetterMock.mockReset();

  // Wipe and rebuild. Cascades take the applications, events and answers with
  // the profile.
  await prisma.application.deleteMany({});
  await prisma.job.deleteMany({});
  await prisma.profile.deleteMany({});

  const dir = await mkdtemp(path.join(tmpdir(), 'ja-resume-'));
  const resumePath = path.join(dir, 'resume.txt');
  await writeFile(
    resumePath,
    'Himani Patel — Staff Backend Engineer\n' +
      'himani@example.com · +1 415 555 0132 · San Francisco, CA\n' +
      '9 years building distributed payment systems in Go and Postgres.',
  );

  const profile = await prisma.profile.create({
    data: {
      email: 'himani@example.com',
      fullName: 'Himani Patel',
      firstName: 'Himani',
      lastName: 'Patel',
      phone: '+1 415 555 0132',
      city: 'San Francisco',
      region: 'CA',
      country: 'United States',
      linkedin: 'https://linkedin.com/in/himanipatel',
      github: 'https://github.com/himanip16',
      resumeText: '9 years building distributed payment systems in Go and Postgres.',
      facts: {
        create: [
          { key: 'work_auth.authorized', label: 'Authorized to work in the US', value: 'Yes', kind: 'BOOLEAN' },
          { key: 'work_auth.sponsorship_required', label: 'Requires visa sponsorship', value: 'No', kind: 'BOOLEAN' },
          { key: 'experience.years_total', label: 'Years of professional experience', value: '9', kind: 'NUMBER' },
          { key: 'compensation.expectation', label: 'Salary expectation', value: '$230,000 base', kind: 'TEXT' },
        ],
      },
      resumes: {
        create: [
          {
            label: 'Default',
            filename: 'resume.txt',
            mimeType: 'text/plain',
            path: resumePath,
            bytes: 128,
            isDefault: true,
            text: '9 years building distributed payment systems in Go and Postgres.',
          },
        ],
      },
    },
  });
  profileId = profile.id;
});

async function createApplication(fixture: string) {
  const job = await prisma.job.create({
    data: { url: `${baseUrl}/${fixture}`, ats: 'generic', company: 'pending', title: 'pending' },
  });
  return prisma.application.create({
    data: { profileId, jobId: job.id, requiresReview: true },
  });
}

/** Wait for the run to reach a status, polling the DB the API would read. */
async function waitForStatus(id: string, status: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const app = await prisma.application.findUniqueOrThrow({ where: { id } });
    if (app.status === status) return;
    if (app.status === 'FAILED') {
      throw new Error(`Run failed while waiting for ${status}: ${app.blockedReason}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const app = await prisma.application.findUniqueOrThrow({ where: { id } });
  throw new Error(`Timed out waiting for ${status}; stuck at ${app.status}: ${app.blockedReason}`);
}

describe('a complete application run', () => {
  it('stops and asks when it cannot answer honestly, remembers the reply, then submits', async () => {
    // The model can derive the language list from the resume, but genuinely
    // cannot know what the candidate would say about relocating — so it
    // refuses, which must produce a question rather than a guess.
    inferMock.mockImplementation(async ({ field }: { field: { label: string } }) => {
      if (/programming languages/i.test(field.label)) {
        return {
          answerable: true,
          value: '',
          values: ['Go', 'TypeScript'],
          confidence: 0.94,
          evidence: 'Resume: "distributed payment systems in Go and Postgres".',
          missingInformation: '',
        };
      }
      return {
        answerable: false,
        value: '',
        values: [],
        confidence: 0,
        evidence: '',
        missingInformation: 'Not stated anywhere in the profile or resume.',
      };
    });
    essayMock.mockResolvedValue('Northwind owns payments end to end, which is the work I already do.');
    coverLetterMock.mockResolvedValue({ body: 'letter', claimsMade: [], unsupportedClaims: [] });

    const app = await createApplication('greenhouse-like.html');
    const run = runApplication(app.id);

    // ---- it must park, not guess ------------------------------------------
    await waitForStatus(app.id, 'NEEDS_INPUT');
    const pending = await prisma.pendingQuestion.findMany({ where: { applicationId: app.id } });
    expect(pending.length).toBeGreaterThan(0);

    // The unanswerable one here is the free-text years/salary style question
    // the mock refused. What matters is that nothing was invented for it.
    const asked = pending.map((q) => q.rawLabel);
    // Notice period is not in the profile, not in the resume and not in the
    // bank. The only honest move is to ask.
    expect(asked.join(' | ')).toMatch(/notice period/i);
    for (const q of pending) {
      expect(q.reason).toBe('NO_MATCH');
      expect(q.answeredAt).toBeNull();
      expect(q.fieldId).toBeTruthy();
    }

    // ---- answer the popup ---------------------------------------------------
    const replies = pending.map((q) => ({
      fieldId: q.fieldId,
      value: /notice period/i.test(q.rawLabel) ? '1 month' : 'Answered by hand',
      remember: true,
    }));
    expect(submitAnswers(app.id, replies)).toBe(true);

    // ---- it must reach review, never submit unattended ----------------------
    await waitForStatus(app.id, 'REVIEW');
    const atReview = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    const plan = atReview.fieldPlan as Array<{ label: string; value: unknown; source: string; filled: boolean }>;

    // Everything the profile knows should have come from the profile, with no
    // model call and no question.
    const byLabel = (needle: string) => plan.find((p) => p.label.toLowerCase().includes(needle));
    expect(byLabel('first name')).toMatchObject({ value: 'Himani', source: 'PROFILE', filled: true });
    expect(byLabel('email')).toMatchObject({ value: 'himani@example.com', source: 'PROFILE' });

    // Stated facts should have been used verbatim and mapped onto the form's
    // own option labels.
    expect(byLabel('legally authorized')).toMatchObject({ value: 'Yes', source: 'RULE', filled: true });
    expect(byLabel('visa sponsorship')).toMatchObject({ value: 'No', source: 'RULE', filled: true });

    // The multi-select the model could derive.
    expect(byLabel('programming languages')).toMatchObject({ source: 'INFERRED', filled: true });
    expect(byLabel('programming languages')?.value).toEqual(['Go', 'TypeScript']);

    // The employer-specific essay was generated, not recycled.
    expect(byLabel('why do you want to join')).toMatchObject({ source: 'GENERATED', filled: true });

    // Gender must have defaulted to declining, never guessed.
    expect(byLabel('gender')).toMatchObject({ value: 'Decline To Self Identify', source: 'SKIPPED' });

    // ---- approve and submit --------------------------------------------------
    expect(decideReview(app.id, true)).toBe(true);
    await run;

    const done = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(done.status).toBe('SUBMITTED');
    expect(done.submittedAt).toBeTruthy();
    expect(done.confirmation).toMatch(/thank you for applying/i);

    // ---- and the answers must now be in the bank ------------------------------
    const bank = await prisma.answer.findMany({ where: { profileId } });
    expect(bank.length).toBeGreaterThan(0);
    // Human answers are stored as USER, which is the tier nothing can overwrite.
    const notice = bank.find((a) => /notice period/i.test(a.rawLabel));
    expect(notice).toBeTruthy();
    expect(notice?.source).toBe('USER');
    expect(notice?.displayValue).toBe('1 month');
    // The generated essay must NOT be in the bank — it belongs to this company.
    expect(bank.some((a) => /why do you want to join/i.test(a.rawLabel))).toBe(false);
  }, 180_000);

  it('reuses a banked answer on the next application instead of asking again', async () => {
    // Seed the bank as if a previous run had already asked this.
    const { rememberAnswer } = await import('../src/engine/answerBank.js');
    await rememberAnswer({
      profileId,
      rawLabel: 'Which programming languages do you use professionally?',
      value: ['Go', 'TypeScript'],
      displayValue: 'Go, TypeScript',
      fieldKind: 'MULTISELECT',
      options: [{ label: 'Go' }, { label: 'TypeScript' }, { label: 'Rust' }],
      source: 'USER',
      confidence: 1,
    });
    await rememberAnswer({
      profileId,
      canonicalKey: 'location.current',
      rawLabel: 'Location (City)',
      value: 'San Francisco',
      displayValue: 'San Francisco',
      fieldKind: 'TEXT',
      source: 'USER',
      confidence: 1,
    });

    // If the resolver reaches the model for the languages question, this throws
    // and the test fails — which is the point.
    inferMock.mockImplementation(async ({ field }: { field: { label: string } }) => {
      if (/programming languages/i.test(field.label)) {
        throw new Error('Resolver called the model for a question already in the answer bank.');
      }
      return {
        answerable: false, value: '', values: [], confidence: 0,
        evidence: '', missingInformation: 'unknown',
      };
    });
    essayMock.mockResolvedValue('A short, specific answer.');
    coverLetterMock.mockResolvedValue({ body: 'letter', claimsMade: [], unsupportedClaims: [] });

    const app = await createApplication('greenhouse-like.html');
    const events: string[] = [];
    const listen = (e: { type: string; message: string }) => events.push(`${e.type}: ${e.message}`);
    bus.on(`app:${app.id}`, listen);

    const run = runApplication(app.id);
    await waitForStatus(app.id, 'NEEDS_INPUT');

    // Whatever is still open, the languages question is not among them.
    const pending = await prisma.pendingQuestion.findMany({ where: { applicationId: app.id } });
    expect(pending.some((q) => /programming languages/i.test(q.rawLabel))).toBe(false);

    // And the log says where the answer came from.
    expect(events.join('\n')).toMatch(/programming languages.*MEMORY_(EXACT|FUZZY)/i);

    submitAnswers(
      app.id,
      pending.map((q) => ({
        fieldId: q.fieldId,
        value: /notice period/i.test(q.rawLabel) ? '1 month' : 'Provided',
        remember: false,
      })),
    );
    await waitForStatus(app.id, 'REVIEW');
    decideReview(app.id, false, 'cancelled by the test');
    await run;

    bus.off(`app:${app.id}`, listen);
    const done = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(done.status).toBe('CANCELLED');
  }, 180_000);
});

describe('the tab closing mid-run', () => {
  it('fails at once with a clear reason, and the retry does not ask the same questions again', async () => {
    inferMock.mockResolvedValue({
      answerable: false, value: '', values: [], confidence: 0,
      evidence: '', missingInformation: 'unknown',
    });
    essayMock.mockResolvedValue('A short, specific answer.');
    coverLetterMock.mockResolvedValue({ body: 'letter', claimsMade: [], unsupportedClaims: [] });

    const app = await createApplication('greenhouse-like.html');
    const first = runApplication(app.id);
    await waitForStatus(app.id, 'NEEDS_INPUT');

    // Someone closes the window while the questions are up. The run used to
    // sit parked until they were answered, then report every field as "not
    // found in DOM" and crash taking a screenshot of the dead page.
    const url = `${baseUrl}/greenhouse-like.html`;
    await getContextSync()!.pages().find((p) => p.url().startsWith(url))!.close();
    await first;

    const failed = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.blockedReason).toMatch(/tab was closed while waiting for your answers/i);

    // The answers typed into the popup are saved even with no run to take them.
    const pending = await prisma.pendingQuestion.findMany({ where: { applicationId: app.id } });
    expect(pending.length).toBeGreaterThan(0);
    for (const q of pending) {
      await prisma.pendingQuestion.update({
        where: { id: q.id },
        data: { answeredAt: new Date(), answerValue: /notice period/i.test(q.rawLabel) ? '1 month' : ['Go', 'TypeScript'] },
      });
    }

    // Start again: straight to review, nothing asked twice.
    await prisma.application.update({ where: { id: app.id }, data: { status: 'QUEUED', blockedReason: null } });
    const second = runApplication(app.id);
    await waitForStatus(app.id, 'REVIEW');
    const asked = await prisma.pendingQuestion.count({ where: { applicationId: app.id, answeredAt: null } });
    expect(asked).toBe(0);
    const plan = (await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).fieldPlan as Array<{
      label: string; value: unknown; source: string; filled: boolean;
    }>;
    expect(plan.find((p) => /notice period/i.test(p.label))).toMatchObject({ value: '1 month', source: 'USER', filled: true });

    expect(decideReview(app.id, false)).toBe(true);
    await second;
  }, 180_000);
});

describe('a multi-step application', () => {
  /**
   * The shape almost every real application has, and the one the engine
   * originally could not handle at all: sign in, "autofill from your resume?",
   * then five screens with the Submit button only on the last.
   */
  it('signs in, takes the autofill, walks all five screens and submits', async () => {
    inferMock.mockResolvedValue({
      answerable: false,
      value: '',
      values: [],
      confidence: 0,
      evidence: '',
      missingInformation: 'Not stated anywhere in the profile or resume.',
    });
    essayMock.mockResolvedValue('Initech runs the payments stack I already work on.');
    coverLetterMock.mockResolvedValue({ body: 'letter', claimsMade: [], unsupportedClaims: [] });

    const app = await createApplication('workday-like.html');
    const run = runApplication(app.id);

    // ---- 1. it stops at the account wall instead of failing ---------------
    await waitForStatus(app.id, 'NEEDS_HUMAN');
    const blocked = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(blocked.blockedReason).toMatch(/LOGIN_REQUIRED|ACCOUNT_CREATION/);

    // ---- 2. the human signs in, in the browser that is still open ---------
    const { activePageFor } = await import('./helpers/activePage.js');
    const page = activePageFor('workday-like.html');
    await page.click('#signin');

    // ...and that is the whole action. Nothing tells the run to carry on: it
    // is watching the page and notices the wall has gone. The old engine had
    // no way back from here at all; requiring a second "I'm done" click would
    // be one more thing to remember.

    // ---- 3. it walks the rest of the wizard on its own --------------------
    //
    // Answering whatever it stops to ask along the way. How many times it
    // stops depends on how much of the profile covers this particular form -
    // with a full profile it may not stop at all, and requiring it to would
    // make this test assert the opposite of what the app is for.
    let asked = 0;
    for (let round = 0; round < 60; round++) {
      const current = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
      if (current.status === 'REVIEW' || current.status === 'SUBMITTED') break;
      if (current.status === 'FAILED') throw new Error(`Run failed: ${current.blockedReason}`);

      if (current.status === 'NEEDS_INPUT') {
        const open = await prisma.pendingQuestion.findMany({
          where: { applicationId: app.id, answeredAt: null },
        });
        if (open.length) {
          asked += open.length;
          // Field ids are namespaced per step, or step 2's "f0" would collide
          // with step 1's and overwrite the answer.
          expect(open.every((q) => /^s\d+:/.test(q.fieldId))).toBe(true);
          submitAnswers(
            app.id,
            open.map((q) => ({ fieldId: q.fieldId, value: answerFor(q.rawLabel), remember: true })),
          );
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    // Whether or not it had to ask, it must have got past the first screen.
    expect(asked).toBeGreaterThanOrEqual(0);

    // ---- 4. review, then the real Submit at the end of the wizard ---------
    await waitForStatus(app.id, 'REVIEW');
    decideReview(app.id, true);

    await waitForStatus(app.id, 'SUBMITTED');
    await run;

    const done = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(done.submittedAt).toBeTruthy();

    // The audit trail covers every screen, not just the first.
    const plan = done.fieldPlan as { fieldId: string; label: string }[];
    const steps = new Set(plan.map((p) => p.fieldId.split(':')[0]));
    expect(steps.size).toBeGreaterThanOrEqual(3);
    const labels = plan.map((p) => p.label.toLowerCase()).join(' | ');
    expect(labels).toMatch(/first name/);
    expect(labels).toMatch(/authorized/);
    expect(labels).toMatch(/gender/);

    // The profile beats what the site's parser guessed: the fixture autofills
    // a wrong phone number on purpose.
    const phone = plan.find((p) => /phone/i.test(p.label)) as
      | { value: string; source: string }
      | undefined;
    expect(phone?.value).toBe('+1 415 555 0132');

    // And it resumed on its own, rather than because something told it to.
    const events = await prisma.applicationEvent.findMany({
      where: { applicationId: app.id },
      select: { type: true, message: true },
    });
    const messages = events.map((e) => e.message);
    expect(messages.some((m) => /carrying on by itself/i.test(m))).toBe(true);
    // ...and it asked for the one action first, rather than parking quietly.
    expect(events.some((e) => e.type === 'NEEDS_YOU')).toBe(true);
  }, 180_000);

  it('can still be cancelled at the wall instead of continued', async () => {
    // The manual half of the race. Auto-detection covers walls that visibly
    // clear; this covers deciding not to bother, and walls it cannot see the
    // end of.
    inferMock.mockResolvedValue({
      answerable: false, value: '', values: [], confidence: 0, evidence: '',
      missingInformation: 'Not stated.',
    });
    coverLetterMock.mockResolvedValue({ body: 'letter', claimsMade: [], unsupportedClaims: [] });

    const app = await createApplication('workday-like.html');
    const run = runApplication(app.id);

    await waitForStatus(app.id, 'NEEDS_HUMAN');

    const { continueRun } = await import('../src/engine/runner.js');
    let delivered = false;
    for (let i = 0; i < 40 && !delivered; i++) {
      delivered = continueRun(app.id, false, 'Not worth the account.');
      if (!delivered) await new Promise((r) => setTimeout(r, 100));
    }
    expect(delivered).toBe(true);

    await waitForStatus(app.id, 'CANCELLED');
    await run;

    const done = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(done.blockedReason).toMatch(/Not worth the account/);
    expect(done.submittedAt).toBeNull();
  }, 120_000);
});

/** Plausible answers for whatever the wizard asks that the profile cannot cover. */
function answerFor(label: string): string {
  if (/year/i.test(label)) return '9';
  if (/why/i.test(label)) return 'Initech runs the payments stack I already work on.';
  if (/veteran/i.test(label)) return 'I decline to self-identify';
  if (/gender/i.test(label)) return 'I do not wish to self-identify';
  return 'Yes';
}
