import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { config, artifactsDir, resumesDir } from './lib/config.js';
import { prisma, type Prisma } from './lib/db.js';
import { bus } from './lib/events.js';
import { enqueue, recoverInterruptedRuns, activeRuns } from './engine/queue.js';
import { submitAnswers, decideReview } from './engine/runner.js';
import { rememberAnswer } from './engine/answerBank.js';
import { adapterFor } from './ats/registry.js';
import { extractResumeText, assessResumeText } from './lib/resumeText.js';
import { estimateActivityCosts, activeModels } from './llm/models.js';
import { provider, isConfigured } from './llm/client.js';
import { schemaProblem, cachedSchemaProblem } from './lib/schemaCheck.js';
import { matchCanonical, normalizeLabel, type RunEvent } from '@ja/shared';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerJobDetailRoutes } from './routes/jobDetail.js';
import { loadSettings } from './lib/secrets.js';
import { isFirecrawlConfigured } from './discovery/firecrawl.js';
import { registerTrackerRoutes } from './routes/tracker.js';
import { registerResumeRoutes } from './routes/resume.js';

const app = Fastify({ logger: { level: 'warn' } });
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });
await mkdir(artifactsDir, { recursive: true });
await mkdir(resumesDir, { recursive: true });
await app.register(fastifyStatic, { root: artifactsDir, prefix: '/artifacts/' });
// Tailored resumes are downloadable from the UI.
await app.register(fastifyStatic, {
  root: resumesDir,
  prefix: '/files/resumes/',
  decorateReply: false,
});

// --------------------------------------------------------------- profile ---

const ProfileInput = z.object({
  email: z.string().email(),
  fullName: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  countryCode: z.string().optional(),
  linkedin: z.string().optional(),
  github: z.string().optional(),
  website: z.string().optional(),
  portfolio: z.string().optional(),
  summary: z.string().optional(),
});

app.get('/api/profile', async () => {
  const profile = await prisma.profile.findFirst({
    include: { facts: { orderBy: { key: 'asc' } }, resumes: { orderBy: { createdAt: 'desc' } } },
  });
  return { profile };
});

app.put('/api/profile', async (req) => {
  const body = ProfileInput.parse(req.body);
  const existing = await prisma.profile.findFirst();
  const profile = existing
    ? await prisma.profile.update({ where: { id: existing.id }, data: body })
    : await prisma.profile.create({ data: body });
  return { profile };
});

const FactInput = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.string(),
  kind: z.enum(['TEXT', 'BOOLEAN', 'NUMBER', 'DATE', 'ENUM', 'LIST']).default('TEXT'),
});

app.post('/api/facts', async (req, reply) => {
  const profile = await requireProfile(reply);
  if (!profile) return;
  const body = FactInput.parse(req.body);
  const fact = await prisma.profileFact.upsert({
    where: { profileId_key: { profileId: profile.id, key: body.key } },
    create: { ...body, profileId: profile.id },
    update: { label: body.label, value: body.value, kind: body.kind },
  });
  return { fact };
});

app.delete<{ Params: { id: string } }>('/api/facts/:id', async (req) => {
  await prisma.profileFact.delete({ where: { id: req.params.id } });
  return { ok: true };
});

// ---------------------------------------------------------------- resume ---

app.post('/api/resume', async (req, reply) => {
  const profile = await requireProfile(reply);
  if (!profile) return;

  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'No file uploaded.' });

  const buf = await file.toBuffer();
  const safeName = file.filename.replace(/[^\w.\-]+/g, '_');
  const dest = path.join(resumesDir, `${Date.now()}-${safeName}`);
  await writeFile(dest, buf);

  let text = '';
  let warning: string | undefined;
  try {
    text = await extractResumeText(dest, file.mimetype);
    warning = assessResumeText(text).warning;
  } catch (err) {
    warning = (err as Error).message;
  }

  const isFirst = (await prisma.resumeFile.count({ where: { profileId: profile.id } })) === 0;
  const record = await prisma.resumeFile.create({
    data: {
      profileId: profile.id,
      label: (file.fields.label as { value?: string } | undefined)?.value ?? 'Default',
      filename: file.filename,
      mimeType: file.mimetype,
      path: dest,
      bytes: buf.length,
      isDefault: isFirst,
      text,
    },
  });
  if (isFirst) {
    await prisma.profile.update({ where: { id: profile.id }, data: { resumeText: text } });
  }
  return { resume: { ...record, text: undefined }, words: text.split(/\s+/).filter(Boolean).length, warning };
});

app.post<{ Params: { id: string } }>('/api/resume/:id/default', async (req, reply) => {
  const profile = await requireProfile(reply);
  if (!profile) return;
  await prisma.resumeFile.updateMany({ where: { profileId: profile.id }, data: { isDefault: false } });
  const r = await prisma.resumeFile.update({ where: { id: req.params.id }, data: { isDefault: true } });
  await prisma.profile.update({ where: { id: profile.id }, data: { resumeText: r.text } });
  return { ok: true };
});

// ----------------------------------------------------------- applications ---

app.post<{ Body: unknown }>('/api/applications', async (req, reply) => {
  const profile = await requireProfile(reply);
  if (!profile) return;

  const { url, autoStart, requiresReview } = z
    .object({
      url: z.string().url(),
      autoStart: z.boolean().default(true),
      requiresReview: z.boolean().default(config.requireReview),
    })
    .parse(req.body);

  const adapter = adapterFor(url);
  const job = await prisma.job.upsert({
    where: { url },
    create: { url, ats: adapter.id, company: 'pending', title: 'pending' },
    update: {},
  });

  const existing = await prisma.application.findUnique({
    where: { profileId_jobId: { profileId: profile.id, jobId: job.id } },
  });
  if (existing && existing.status === 'SUBMITTED') {
    return reply.code(409).send({
      error: 'You already applied to this job.',
      applicationId: existing.id,
      submittedAt: existing.submittedAt,
    });
  }

  const application =
    existing ??
    (await prisma.application.create({
      data: { profileId: profile.id, jobId: job.id, requiresReview },
    }));

  if (existing) {
    await prisma.application.update({
      where: { id: existing.id },
      data: { status: 'QUEUED', blockedReason: null, requiresReview },
    });
    await prisma.pendingQuestion.deleteMany({ where: { applicationId: existing.id, answeredAt: null } });
  }

  if (autoStart) enqueue(application.id);
  return { applicationId: application.id, ats: adapter.id, notes: adapter.notes };
});

app.get('/api/applications', async () => {
  const applications = await prisma.application.findMany({
    include: { job: true, _count: { select: { pending: { where: { answeredAt: null } } } } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  return { applications, active: activeRuns() };
});

app.get<{ Params: { id: string } }>('/api/applications/:id', async (req, reply) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: {
      job: true,
      events: { orderBy: { createdAt: 'asc' }, take: 500 },
      pending: { orderBy: { createdAt: 'asc' } },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!application) return reply.code(404).send({ error: 'Not found' });
  return { application };
});

app.post<{ Params: { id: string } }>('/api/applications/:id/start', async (req) => {
  await prisma.application.update({
    where: { id: req.params.id },
    data: { status: 'QUEUED', blockedReason: null },
  });
  enqueue(req.params.id);
  return { ok: true };
});

/**
 * The answer popup posts here. Answers land in the bank straight away when the
 * user asks to remember them, so the knowledge survives even if this
 * particular application is later abandoned.
 */
app.post<{ Params: { id: string } }>('/api/applications/:id/answers', async (req, reply) => {
  const profile = await requireProfile(reply);
  if (!profile) return;

  const { answers } = z
    .object({
      answers: z.array(
        z.object({
          fieldId: z.string(),
          questionId: z.string().optional(),
          value: z.union([z.string(), z.array(z.string())]),
          remember: z.boolean().default(true),
        }),
      ),
    })
    .parse(req.body);

  for (const a of answers) {
    if (a.questionId) {
      const q = await prisma.pendingQuestion.update({
        where: { id: a.questionId },
        data: {
          answeredAt: new Date(),
          answerValue: a.value as Prisma.InputJsonValue,
          remember: a.remember,
        },
      });
      if (a.remember) {
        // Match the runner's identity rules exactly, or the same answer lands
        // twice: once now, once after a confirmed submit.
        const canonical = matchCanonical(q.rawLabel);
        const application = await prisma.application.findUnique({
          where: { id: req.params.id },
          include: { job: true },
        });
        await rememberAnswer({
          profileId: profile.id,
          canonicalKey: canonical?.key,
          rawLabel: q.rawLabel,
          value: a.value,
          displayValue: Array.isArray(a.value) ? a.value.join(', ') : a.value,
          fieldKind: q.fieldKind,
          options: (q.options ?? undefined) as { label: string }[] | undefined,
          source: 'USER',
          confidence: 1,
          scope: canonical?.perCompany ? 'PER_COMPANY' : 'GLOBAL',
          companyKey: application ? normalizeLabel(application.job.company) : undefined,
        });
      }
    }
  }

  const delivered = submitAnswers(req.params.id, answers.map((a) => ({
    fieldId: a.fieldId,
    value: a.value,
    remember: a.remember,
  })));

  if (!delivered) {
    return reply.code(409).send({
      error: 'That run is not currently waiting for answers. They were saved to your answer bank; restart the application to use them.',
    });
  }
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/applications/:id/review', async (req, reply) => {
  const { approved, note } = z
    .object({ approved: z.boolean(), note: z.string().optional() })
    .parse(req.body);
  const delivered = decideReview(req.params.id, approved, note);
  if (!delivered) return reply.code(409).send({ error: 'That run is not waiting for review.' });
  return { ok: true };
});

// -------------------------------------------------------- live event feed ---

app.get<{ Params: { id: string } }>('/api/applications/:id/stream', async (req, reply) => {
  // Writing to reply.raw bypasses Fastify's onSend hooks, which is where
  // @fastify/cors injects its headers - so an SSE response reaches the browser
  // with no Access-Control-Allow-Origin and the EventSource is rejected before
  // a single event is delivered. Set them here by hand.
  const origin = (req.headers.origin as string | undefined) ?? '*';
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  });

  const send = (evt: RunEvent) => {
    reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // Replay history so a refresh does not lose the narrative.
  const history = await prisma.applicationEvent.findMany({
    where: { applicationId: req.params.id },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  for (const e of history) {
    send({
      applicationId: e.applicationId,
      type: e.type,
      message: e.message,
      data: e.data,
      at: e.createdAt.toISOString(),
    });
  }

  const channel = `app:${req.params.id}`;
  bus.on(channel, send);
  const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    bus.off(channel, send);
  });
});

// ------------------------------------------------------------ answer bank ---

app.get('/api/answers', async (_req, reply) => {
  const profile = await requireProfile(reply);
  if (!profile) return;
  const answers = await prisma.answer.findMany({
    where: { profileId: profile.id },
    orderBy: [{ timesUsed: 'desc' }, { updatedAt: 'desc' }],
  });
  return { answers: answers.map(({ vector: _vector, ...rest }) => rest) };
});

app.patch<{ Params: { id: string } }>('/api/answers/:id', async (req) => {
  const { displayValue } = z.object({ displayValue: z.string() }).parse(req.body);
  const answer = await prisma.answer.update({
    where: { id: req.params.id },
    data: { displayValue, value: displayValue, source: 'USER', confidence: 1 },
  });
  return { answer };
});

app.delete<{ Params: { id: string } }>('/api/answers/:id', async (req) => {
  await prisma.answer.delete({ where: { id: req.params.id } });
  return { ok: true };
});

// ------------------------------------------------- discovery, resume, tracker ---

registerDiscoveryRoutes(app, requireProfile);
registerResumeRoutes(app, requireProfile);
registerTrackerRoutes(app, requireProfile);
registerSettingsRoutes(app);
registerJobDetailRoutes(app);

// ----------------------------------------------------------------- health ---

app.get('/api/health', async () => ({
  ok: true,
  llmConfigured: isConfigured(),
  searchConfigured: isFirecrawlConfigured(),
  ...activeModels(),
  // Rough, local, and always an estimate - the real figure is on your console.
  estimatedCosts: estimateActivityCosts(),
  headless: config.headless,
  requireReview: config.requireReview,
  activeRuns: activeRuns(),
}));

/**
 * Everything the home page needs to explain itself.
 *
 * Two jobs. It reports what is still unconfigured, so a fresh install tells
 * you what to do next instead of failing later with a stack trace. And it
 * counts everything currently waiting on a human, across all four features,
 * because "three things need you" is the one number worth putting at the top
 * of a page.
 */
app.get('/api/overview', async () => {
  const profile = await prisma.profile.findFirst({
    include: { facts: true, resumes: true, _count: { select: { answers: true } } },
  });

  // Every count is guarded. This endpoint is the one that reports a broken
  // install, so it has to survive one - a stale client or a missing table must
  // degrade a number to zero, not take the whole dashboard down with a
  // TypeError the user cannot act on.
  const [
    companies,
    leadsNew,
    needsInput,
    needsHuman,
    inReview,
    submitted,
    upcomingRounds,
    lessons,
    strongMatches,
    leadsTotal,
    shortlisted,
  ] =
    await Promise.all([
      safeCount(() => prisma.company.count({ where: { enabled: true } })),
      profile
        ? safeCount(() => prisma.jobLead.count({ where: { profileId: profile.id, status: 'NEW' } }))
        : 0,
      safeCount(() => prisma.application.count({ where: { status: 'NEEDS_INPUT' } })),
      safeCount(() => prisma.application.count({ where: { status: 'NEEDS_HUMAN' } })),
      safeCount(() => prisma.application.count({ where: { status: 'REVIEW' } })),
      safeCount(() => prisma.application.count({ where: { status: 'SUBMITTED' } })),
      safeCount(() => prisma.interviewRound.count({ where: { status: 'SCHEDULED' } })),
      safeCount(() => prisma.lesson.count()),
      // The headline numbers. "Strong" is the same threshold the lead cards
      // colour green at, so the front page and the queue never disagree.
      safeCount(() =>
        profile
          ? prisma.jobLead.count({ where: { profileId: profile.id, status: 'NEW', score: { gte: 70 } } })
          : Promise.resolve(0),
      ),
      safeCount(() => (profile ? prisma.jobLead.count({ where: { profileId: profile.id } }) : Promise.resolve(0))),
      safeCount(() => prisma.jobLead.count({ where: { status: 'SHORTLISTED' } })),
    ]);

  const schema = await cachedSchemaProblem();

  const standingAnswers = profile?.facts.length ?? 0;

  // Ordered: each step is genuinely blocked by the one above it.
  const setup = [
    {
      id: 'schema',
      label: 'Sync the database',
      done: schema === null,
      detail: schema ?? 'Client, schema and tables all match.',
      href: null,
    },
    {
      id: 'model',
      label: 'Connect a model',
      done: isConfigured(),
      detail: isConfigured()
        ? `${activeModels().provider} · ${activeModels().writing}`
        : 'Gemini has a free tier. Paste the key on the settings page — no restart needed.',
      href: '/settings',
    },
    {
      id: 'profile',
      label: 'Fill in your profile',
      done: Boolean(profile?.email && profile?.fullName),
      detail: profile ? `${profile.fullName} · ${profile.email}` : 'Name, contact and links fill half of every form directly.',
      href: '/profile',
    },
    {
      id: 'resume',
      label: 'Upload your resume',
      done: (profile?.resumes.length ?? 0) > 0,
      detail: profile?.resumes.length
        ? `${profile.resumes.length} on file`
        : 'Attached to applications, and the only thing claims can be grounded in.',
      href: '/profile',
    },
    {
      id: 'facts',
      label: 'Answer the standing questions',
      done: standingAnswers >= 5,
      detail:
        standingAnswers >= 5
          ? `${standingAnswers} recorded`
          : `${standingAnswers} of ~11 filled. Each one is a popup you will not see later.`,
      href: '/profile',
    },
    {
      id: 'search',
      label: 'Turn on job search',
      done: isFirecrawlConfigured(),
      detail: isFirecrawlConfigured()
        ? companies > 0
          ? `Ready. ${companies} board(s) found so far.`
          : 'Ready. Hit "Find jobs for me" and it will go looking.'
        : 'Paste a Firecrawl key on the settings page and it will find openings on its own.',
      href: '/settings',
    },
  ];

  return {
    setup,
    ready: setup.slice(0, 4).every((s) => s.done),
    needsYou: { needsInput, inReview, needsHuman, total: needsInput + inReview + needsHuman },
    counts: {
      leadsNew,
      leadsTotal,
      strongMatches,
      shortlisted,
      submitted,
      upcomingRounds,
      lessons,
      answerBank: profile?._count.answers ?? 0,
      companies,
    },
  };
});

/**
 * What this API key can actually reach.
 *
 * Model ids move — Gemini has renamed and deprecated several inside a year —
 * so rather than trusting a hard-coded default, ask the provider and let the
 * UI show real options.
 */
app.get('/api/models', async () => {
  try {
    const p = provider();
    return { provider: p.id, models: await p.listModels(), active: activeModels() };
  } catch (err) {
    return { provider: null, models: [], error: (err as Error).message };
  }
});

/** A count that reports zero rather than taking the page down. */
async function safeCount(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch {
    return 0;
  }
}

async function requireProfile(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  const profile = await prisma.profile.findFirst();
  if (!profile) {
    reply.code(400).send({ error: 'Create your profile first (PUT /api/profile).' });
    return null;
  }
  return profile;
}

// Say it once at boot, loudly, rather than once per request. A stale generated
// client produces "Cannot read properties of undefined" from whichever endpoint
// hits the missing model first, which names neither the cause nor the fix.
//
// Deliberately not fatal. Most people only ever see this app through the
// browser, and a process that refuses to start can only tell them "cannot
// reach the server" - which is a worse message than the real one. So it keeps
// serving, and /api/overview puts the same sentence at the top of the setup
// checklist with the command in it.
const bootProblem = await schemaProblem();
if (bootProblem) process.stderr.write(`\n${bootProblem}\n\n`);

// Before anything reads a key. Keys saved from the settings page live in the
// database, and config.ts reads them through an in-memory cache that this
// fills - so a server that skipped this would quietly behave as though every
// key you saved had been forgotten.
const savedSettings = await loadSettings();
if (savedSettings) process.stdout.write(`Loaded ${savedSettings} setting(s) saved from the UI.\n`);

const recovered = await recoverInterruptedRuns();
if (recovered) {
  process.stdout.write(`Requeued ${recovered} run(s) interrupted by a restart.\n`);
}

await app.listen({ port: config.port, host: '0.0.0.0' });
process.stdout.write(`API on http://localhost:${config.port}\n`);
