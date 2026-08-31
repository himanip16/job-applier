import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config, artifactsDir, resumesDir } from './lib/config.js';
import { prisma } from './lib/db.js';
import { recoverInterruptedRuns, activeRuns } from './engine/queue.js';
import { estimateActivityCosts, activeModels } from './llm/models.js';
import { isConfigured } from './llm/client.js';
import { schemaProblem, cachedSchemaProblem } from './lib/schemaCheck.js';
import { currentUser } from './auth/sessions.js';
import { loadSettings } from './lib/secrets.js';
import { isFirecrawlConfigured } from './discovery/firecrawl.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerJobDetailRoutes } from './routes/jobDetail.js';
import { registerTrackerRoutes } from './routes/tracker.js';
import { registerResumeRoutes } from './routes/resume.js';
import { registerOutreachRoutes } from './routes/outreach.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerFactsRoutes } from './routes/facts.js';
import { registerApplicationRoutes } from './routes/applications.js';
import { registerAnswerRoutes } from './routes/answers.js';
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
  if (PROTECTED_STATIC.some(prefix => path.startsWith(prefix))) {
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

// --------------------------------------------------------------- routes ---

/**
 * The dossier the caller is allowed to act on.
 *
 * Every feature in this app is scoped by profileId already, so making the app
 * multi-user is almost entirely a matter of this one function no longer
 * answering "the first row in the table".
 */
async function requireProfile(
  req: { headers: { cookie?: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  const user = await currentUser(req as FastifyRequest);
  if (!user) {
    reply.code(401).send({ error: 'Sign in to use this.' });
    return null;
  }
  const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
  if (!profile) {
    reply.code(400).send({ error: 'Create your profile first (PUT /api/profile).' });
    return null;
  }
  return profile;
}

/**
 * Require authentication only, not necessarily a profile.
 * Used for endpoints that need user context but not profile data.
 */
async function requireUser(
  req: { headers: { cookie?: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) {
  const user = await currentUser(req as FastifyRequest);
  if (!user) {
    reply.code(401).send({ error: 'Sign in to use this.' });
    return null;
  }
  return user;
}

export type RequireUser = (
  req: { headers: { cookie?: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => Promise<{ id: string } | null>;

registerAuthRoutes(app);
registerDiscoveryRoutes(app, requireProfile);
registerResumeRoutes(app, requireProfile);
registerTrackerRoutes(app, requireProfile);
registerSettingsRoutes(app);
registerJobDetailRoutes(app, requireProfile);
registerOutreachRoutes(app);
registerProfileRoutes(app, requireProfile);
registerFactsRoutes(app, requireProfile);
registerApplicationRoutes(app, requireProfile);
registerAnswerRoutes(app, requireProfile);
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

await app.listen({ port: config.port, host: '0.0.0.0' });
process.stdout.write(`API on http://localhost:${config.port}\n`);
