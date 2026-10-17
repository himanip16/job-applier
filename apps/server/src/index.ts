import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config, artifactsDir, resumesDir } from './lib/config.js';
import { prisma } from './lib/db.js';
import { rescoreLexically } from './discovery/rescoreLeads.js';
import { recoverInterruptedRuns, activeRuns } from './engine/queue.js';
import { reconcileLeads } from './engine/leadSync.js';
import { estimateActivityCosts, activeModels } from './llm/models.js';
import { isConfigured, LlmUnavailableError } from './llm/client.js';
import { schemaProblem, cachedSchemaProblem } from './lib/schemaCheck.js';
import { currentUser } from './auth/sessions.js';
import { loadSettings } from './lib/secrets.js';
import { isFirecrawlConfigured } from './discovery/firecrawl.js';
import { ZodError } from 'zod';
import { requireProfile, requireUser, type RequireUser } from './auth/requireProfile.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCompanyRoutes } from './routes/companies.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerCompanySearchRoutes } from './routes/companySearch.js';
import { registerLeadRoutes } from './routes/leads.js';
import { registerPreferenceRoutes } from './routes/preferences.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerJobDetailRoutes } from './routes/jobDetail.js';
import { registerTrackerRoutes } from './routes/tracker.js';
import { registerResumeRoutes } from './routes/resume.js';
import { registerOutreachRoutes } from './routes/outreach.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerFactsRoutes } from './routes/facts.js';
import { registerApplicationRoutes } from './routes/applications.js';
import { registerAnswerRoutes } from './routes/answers.js';
import { registerQuestionDraftRoutes } from './routes/questionDrafts.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerResumeUploadRoutes } from './routes/resumeUpload.js';
import { registerOverviewRoutes } from './routes/overview.js';

const app = Fastify({ logger: { level: 'warn' } });
/**
 * Reflect the caller's origin, and allow credentials.
 *
 * The session cookie is the whole authentication mechanism, and a browser
 * will not send one cross-origin unless the server says credentials are
 * allowed - which it may only do for a named origin, never for `*`. WEB_ORIGIN
 * pins it in production; reflecting is right in development, where the port
 * moves around.
 */
const allowedOrigins = (process.env.WEB_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
await app.register(cors, {
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true,
});

await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });

/**
 * Static files also require authentication.
 *
 * Resumes and artifacts contain personal information, so they must be
 * protected behind the same auth checks as the API. This hook runs before
 * the static file handlers to ensure auth is checked first.
 */
const PROTECTED_STATIC = ['/artifacts/', '/files/resumes/'];
app.addHook('onRequest', async (req, reply) => {
  const path = req.url.split('?')[0] ?? '';
  const protectedArray = Array.isArray(PROTECTED_STATIC) ? PROTECTED_STATIC : [];
  if (protectedArray.some(prefix => path.startsWith(prefix))) {
    if (await currentUser(req)) return;
    return reply.code(401).send({ error: 'Sign in to use this.' });
  }
});

/**
 * Nothing under /api answers a stranger.
 *
 * Deliberately a hook rather than a check inside each handler. There are
 * forty-odd routes and one of them will always be the one somebody forgets;
 * a default-deny list of four public paths cannot be forgotten.
 */
const PUBLIC_API = new Set([
  '/api/auth/me',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
  '/api/auth/reset-request',
  '/api/auth/reset-complete',
  '/api/health',
]);
app.addHook('preHandler', async (req, reply) => {
  const path = req.url.split('?')[0] ?? '';
  if (!path.startsWith('/api/') || PUBLIC_API.has(path)) return;
  if (await currentUser(req)) return;
  return reply.code(401).send({ error: 'Sign in to use this.' });
});
await mkdir(artifactsDir, { recursive: true });
await mkdir(resumesDir, { recursive: true });
await app.register(fastifyStatic, { root: artifactsDir, prefix: '/artifacts/' });
// Tailored resumes are downloadable from the UI.
await app.register(fastifyStatic, {
  root: resumesDir,
  prefix: '/files/resumes/',
  decorateReply: false,
});

/**
 * An empty body is not a malformed body.
 *
 * Fastify's default JSON parser rejects `Content-Type: application/json` with
 * no payload, which is a reasonable reading of the spec and a hostile one for
 * a client that sets the header once for every request. Several endpoints here
 * take no body at all, so treat empty as `{}` and let the route's own schema
 * decide what is required.
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return done(null, {});
  try {
    done(null, JSON.parse(text));
  } catch (err) {
    done(err as Error, undefined);
  }
});

// --------------------------------------------------------------- error handling ---

/**
 * Global error handler for LLM, Zod validation, and other known error types.
 *
 * This ensures that:
 * - Rate limit errors return 429 instead of 500
 * - Zod validation errors return 400 with detailed issues
 * - Other LLM errors return appropriate status codes with user-friendly messages
 */
app.setErrorHandler((err, req, reply) => {
  // Handle Zod validation errors
  if (err instanceof ZodError) {
    return reply.code(400).send({
      error: 'Invalid request',
      issues: (err as any).issues,
    });
  }

  if (err instanceof LlmUnavailableError) {
    // Rate limit errors should return 429
    if (err.retryable && /rate limit|quota exhausted|429/i.test(err.message)) {
      return reply.code(429).send({ error: err.message });
    }
    // Other LLM unavailability errors (bad key, no key, etc.) return 400
    return reply.code(400).send({ error: err.message });
  }

  // Log unexpected errors and return 500
  req.log.error(err);
  return reply.code(500).send({ error: 'Internal server error' });
});

// --------------------------------------------------------------- routes ---

registerAuthRoutes(app);
registerCompanyRoutes(app, requireProfile);
registerDiscoveryRoutes(app, requireProfile);
registerCompanySearchRoutes(app, requireProfile);
registerLeadRoutes(app, requireProfile);
registerPreferenceRoutes(app, requireProfile);
registerResumeRoutes(app, requireProfile);
registerTrackerRoutes(app, requireProfile);
registerSettingsRoutes(app);
registerJobDetailRoutes(app, requireProfile);
registerOutreachRoutes(app);
registerProfileRoutes(app, requireProfile);
registerConnectionRoutes(app, requireProfile);
registerFactsRoutes(app, requireProfile);
registerApplicationRoutes(app, requireProfile);
registerAnswerRoutes(app, requireProfile);
registerQuestionDraftRoutes(app, requireProfile);
registerStreamRoutes(app, requireProfile);
registerResumeUploadRoutes(app, requireProfile);
registerOverviewRoutes(app);

// ----------------------------------------------------------------- health ---

/**
 * Public health check - minimal information only.
 *
 * Detailed diagnostics are available to authenticated users via /api/system.
 */
app.get('/api/health', async () => ({
  ok: true,
}));

// --------------------------------------------------------------- startup ---

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

// Cards a run moved before Applied meant submitted go where their run says now.
const moved = Object.entries(await reconcileLeads().catch(() => ({})));
if (moved.length) process.stdout.write(`Re-sorted job cards: ${moved.map(([tab, n]) => `${n} to ${tab}`).join(', ')}.\n`);

await app.listen({ port: config.port, host: '0.0.0.0' });
process.stdout.write(`API on http://localhost:${config.port}\n`);

// Quick scores are stored, so a change to how they are worked out reached a
// card only when something else happened to rescore it - a reject, a
// shortlist, a crawl. Until then an intern role kept the 100% the old rules
// gave it. Cheap (no model calls), so it runs on every start, after listening.
void (async () => {
  for (const { id } of await prisma.profile.findMany({ select: { id: true } })) {
    const n = await rescoreLexically(id);
    if (n) process.stdout.write(`Rescored ${n} quick-match lead(s) with the current rules.\n`);
  }
})().catch((err) => process.stderr.write(`Quick rescore on start failed: ${(err as Error).message}\n`));
