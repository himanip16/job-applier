import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Prisma } from '../lib/db.js';
import { API_SOURCES } from '../discovery/sources.js';
import { crawlAll, rescore } from '../discovery/crawler.js';
import { findJobs } from '../discovery/findJobs.js';
import { isFirecrawlConfigured } from '../discovery/firecrawl.js';
import { learnFromDecision, loadSignals } from '../discovery/scoring.js';
import { rescoreByIds, rescoreLexically } from '../discovery/rescoreLeads.js';
import { NOT_YOURS, ownedLead, ownedSignal } from '../auth/ownership.js';
import { adapterFor } from '../ats/registry.js';
import { enqueue } from '../engine/queue.js';

/**
 * Coarse buckets for a rejection.
 *
 * Offered as one-tap chips alongside the free-text box, because a category is
 * cheap to give and a sentence is not — and something is far better than the
 * nothing you get when the only option is a blank textarea.
 */
export const REJECT_CATEGORIES = [
  'Too junior',
  'Too senior',
  'Wrong tech stack',
  'Wrong domain',
  'Location or commute',
  'No visa sponsorship',
  'Compensation',
  'Company or culture',
  'Already applied elsewhere',
  'Not looking for this type of role',
] as const;

/**
 * How many leads one "rescore selected" press may read.
 *
 * Each one is a model call taking seconds, run in series, and the browser is
 * holding the request open the whole time. Twenty-five is about a minute of
 * waiting, which is the most a button press should ever ask for.
 */
export const MAX_RESCORE_BATCH = 25;

export function registerDiscoveryRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  // ------------------------------------------------------------- companies ---

  app.get('/api/sources', async () => ({
    sources: API_SOURCES.map((s) => ({ id: s.id, handleHint: s.handleHint })).concat([
      { id: 'careers-page', handleHint: 'full URL of the careers page to crawl' },
    ]),
    rejectCategories: REJECT_CATEGORIES,
    searchConfigured: isFirecrawlConfigured(),
  }));

  app.get('/api/companies', async () => ({
    companies: await prisma.company.findMany({ orderBy: { name: 'asc' } }),
  }));

  app.post('/api/companies', async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        source: z.enum(['greenhouse', 'lever', 'ashby', 'workable', 'careers-page']),
        handle: z.string().min(1),
      })
      .parse(req.body);
    const company = await prisma.company.upsert({
      where: { source_handle: { source: body.source, handle: body.handle } },
      create: body,
      update: { name: body.name, enabled: true },
    });
    return { company };
  });

  app.delete<{ Params: { id: string } }>('/api/companies/:id', async (req) => {
    await prisma.company.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ----------------------------------------------------------------- crawl ---

  app.post('/api/discovery/crawl', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { deepScoreTop, companyId } = z
      .object({ deepScoreTop: z.number().min(0).max(60).default(15), companyId: z.string().optional() })
      .parse(req.body ?? {});
    const report = await crawlAll(profile.id, { deepScoreTop, onlyCompanyId: companyId });
    return { report };
  });

  /**
   * Find openings without being told where to look.
   *
   * The primary way in. `/crawl` re-reads boards you already know about;
   * this one goes and finds them, so the first run needs nothing but a
   * resume.
   */
  app.post('/api/discovery/find', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const body = z
      .object({
        dryRun: z.boolean().default(false),
        maxQueries: z.number().min(1).max(12).optional(),
        resultsPerQuery: z.number().min(1).max(30).optional(),
        maxBoards: z.number().min(1).max(60).optional(),
        deepScoreTop: z.number().min(0).max(60).default(15),
      })
      .parse(req.body ?? {});

    // A dry run never touches Firecrawl, so it works without a key - which is
    // exactly when you most want to see what the app thinks it would do.
    if (!body.dryRun && !isFirecrawlConfigured()) {
      return reply.code(400).send({
        error:
          'Job search needs a Firecrawl key. Get one free at firecrawl.dev, put ' +
          'FIRECRAWL_API_KEY in .env, and restart the server. Everything else works without it.',
      });
    }

    try {
      return { report: await findJobs(profile.id, body) };
    } catch (err) {
      // Everything reachable from here is a message written for a person -
      // an empty profile, a rejected key, an exhausted balance.
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Read one posting properly.
   *
   * A crawl only sends its top slice to a model, so most leads carry a keyword
   * score and a list of matched words - which is honest but thin, and next to
   * a lead that did get read it looks broken. This is the "actually look at
   * this one" button.
   */
  app.post<{ Params: { id: string } }>('/api/leads/:id/rescore', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const [outcome] = await rescoreByIds(profile.id, [req.params.id]);
    if (!outcome) return reply.code(404).send({ error: 'Not found' });
    if (!outcome.ok) {
      const code =
        outcome.reason === 'not-found' ? 404 : outcome.reason === 'declined' ? 502 : 400;
      return reply.code(code).send({ error: outcome.error });
    }

    const lead = await ownedLead(profile.id, req.params.id);
    return { lead: lead && { ...lead, descriptionText: undefined } };
  });

  /**
   * Read the postings the candidate picked.
   *
   * Deliberately by id rather than "rescore everything": a model pass costs
   * money and a minute of waiting per lead, and most of a queue is jobs you
   * have already decided you do not want. Ticking four boxes and pressing the
   * button spends four calls, not sixty.
   */
  app.post('/api/leads/rescore', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { ids } = z
      .object({ ids: z.array(z.string().min(1)).min(1).max(MAX_RESCORE_BATCH) })
      .parse(req.body ?? {});

    const results = await rescoreByIds(profile.id, ids);
    return { results, rescored: results.filter((r) => r.ok).length };
  });

  app.post('/api/discovery/rescore', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { limit } = z.object({ limit: z.number().min(1).max(60).default(20) }).parse(req.body ?? {});
    return { rescored: await rescore(profile.id, limit) };
  });

  // ----------------------------------------------------------------- leads ---

  const LeadQuery = z.object({
    status: z.string().default('NEW'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.enum(['score', 'discovered', 'company', 'title']).default('score'),
    dir: z.enum(['desc', 'asc']).default('desc'),
    /** Free text over the title, the company and the location. */
    q: z.string().trim().default(''),
    remote: z.enum(['any', 'yes', 'no']).default('any'),
    minScore: z.coerce.number().min(0).max(100).optional(),
    /** Whether a model has read the posting, or only the keyword pass has. */
    depth: z.enum(['any', 'deep', 'quick']).default('any'),
  });

  app.get('/api/leads', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const query = LeadQuery.parse(req.query ?? {});

    const where: Prisma.JobLeadWhereInput = { profileId: profile.id };
    if (query.status !== 'ALL') where.status = query.status as Prisma.JobLeadWhereInput['status'];
    if (query.remote !== 'any') where.remote = query.remote === 'yes';
    if (query.minScore !== undefined) where.score = { gte: query.minScore };
    if (query.depth !== 'any') where.deepScored = query.depth === 'deep';
    if (query.q) {
      where.OR = [
        { title: { contains: query.q, mode: 'insensitive' } },
        { companyName: { contains: query.q, mode: 'insensitive' } },
        { location: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    // Every sort ends in a stable tiebreak. Without one, two leads with the
    // same score can swap places between page 1 and page 2 and the same job
    // shows up twice - or not at all.
    const orderBy: Prisma.JobLeadOrderByWithRelationInput[] =
      query.sort === 'discovered'
        ? [{ discoveredAt: query.dir }]
        : query.sort === 'company'
          ? [{ companyName: query.dir }, { title: 'asc' }]
          : query.sort === 'title'
            ? [{ title: query.dir }, { companyName: 'asc' }]
            : [{ score: query.dir }, { discoveredAt: 'desc' }];
    orderBy.push({ id: 'asc' });

    const [total, counts, strong] = await Promise.all([
      prisma.jobLead.count({ where }),
      prisma.jobLead.groupBy({ by: ['status'], where: { profileId: profile.id }, _count: true }),
      prisma.jobLead.count({ where: { profileId: profile.id, status: 'NEW', score: { gte: 70 } } }),
    ]);

    // Clamp rather than 404: deciding on the last lead of the last page would
    // otherwise land you on an empty one, which reads as "everything is gone".
    const pages = Math.max(1, Math.ceil(total / query.limit));
    const page = Math.min(query.page, pages);

    const leads = await prisma.jobLead.findMany({
      where,
      orderBy,
      skip: (page - 1) * query.limit,
      take: query.limit,
    });

    return {
      // The description is large and the list view never shows it in full.
      leads: leads.map((l) => ({ ...l, descriptionText: l.descriptionText?.slice(0, 600) ?? null })),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      total,
      page,
      pages,
      limit: query.limit,
      /** New leads at or above the "start here" threshold, across every page. */
      strong,
      maxRescoreBatch: MAX_RESCORE_BATCH,
      // The same numbers under the shape the first paginated build returned,
      // so nothing that already reads `pagination` breaks on the way past.
      pagination: { page, pageSize: query.limit, total, totalPages: pages },
    };
  });

  app.get<{ Params: { id: string } }>('/api/leads/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const lead = await ownedLead(profile.id, req.params.id);
    if (!lead) return reply.code(404).send(NOT_YOURS);
    return { lead };
  });

  /**
   * Reject a lead. The reason is optional on purpose: demanding one makes
   * people type "n/a" to get past the dialog, and "n/a" is worse than silence
   * because the learner treats it as signal.
   */
  app.post<{ Params: { id: string } }>('/api/leads/:id/reject', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { reason, category } = z
      .object({ reason: z.string().optional(), category: z.string().optional() })
      .parse(req.body ?? {});

    const lead = await ownedLead(profile.id, req.params.id);
    if (!lead) return reply.code(404).send({ error: 'Not found' });
    // Learn from the candidate's decision, then permanently remove the
    // lead from the queue. This keeps the triage queue focused and avoids
    // re-offering things they've explicitly rejected.
    await learnFromDecision({
      profileId: profile.id,
      job: {
        title: lead.title,
        descriptionText: lead.descriptionText ?? '',
        location: lead.location ?? undefined,
      },
      accepted: false,
      reason: [category, reason].filter(Boolean).join('. ') || undefined,
    });

    await prisma.jobLead.delete({ where: { id: lead.id } });
    // Re-rank what remains so the effect of the decision is visible now.
    const reranked = await rescoreLexically(profile.id);
    return { ok: true, reranked, message: `Removed lead and re-ranked ${reranked} remaining lead(s).` };
  });

  app.post<{ Params: { id: string } }>('/api/leads/:id/shortlist', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const lead = await ownedLead(profile.id, req.params.id);
    if (!lead) return reply.code(404).send({ error: 'Not found' });

    await prisma.jobLead.update({
      where: { id: lead.id },
      data: { status: 'SHORTLISTED', decidedAt: new Date() },
    });
    await learnFromDecision({
      profileId: profile.id,
      job: {
        title: lead.title,
        descriptionText: lead.descriptionText ?? '',
        location: lead.location ?? undefined,
      },
      accepted: true,
    });
    const reranked = await rescoreLexically(profile.id);
    return { ok: true, reranked };
  });

  /**
   * "I applied to this one myself."
   *
   * Distinct from Apply, which drives the browser. Plenty of postings are
   * quicker to fill in by hand - a two-field form, a company that wants an
   * email - and before this the only way to record one was to let the
   * automation try and fail, or to lose the fact entirely. Losing it is the
   * worst option: the job comes back in the next crawl looking untouched.
   *
   * It creates the Application the tracker needs, marked SUBMITTED because it
   * was, so rounds and outcomes hang off it like any other.
   */
  app.post<{ Params: { id: string } }>('/api/leads/:id/applied', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { note } = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});

    const lead = await ownedLead(profile.id, req.params.id);
    if (!lead) return reply.code(404).send(NOT_YOURS);

    const adapter = adapterFor(lead.url);
    const job = await prisma.job.upsert({
      where: { url: lead.url },
      create: {
        url: lead.url,
        ats: adapter.id,
        company: lead.companyName,
        title: lead.title,
        location: lead.location,
        descriptionText: lead.descriptionText,
      },
      update: {},
    });

    const application = await prisma.application.upsert({
      where: { profileId_jobId: { profileId: profile.id, jobId: job.id } },
      create: {
        profileId: profile.id,
        jobId: job.id,
        status: 'SUBMITTED',
        outcome: 'IN_PROGRESS',
        submittedAt: new Date(),
        requiresReview: false,
        notes: note ?? 'Applied by hand, outside the automation.',
      },
      // Never downgrade a real run. If the automation already submitted this,
      // the run's own record of what it sent is worth more than this flag.
      update: {},
    });

    await prisma.jobLead.update({
      where: { id: lead.id },
      data: { status: 'APPLIED', applicationId: application.id, decidedAt: new Date() },
    });
    // Applying is the strongest "yes" there is, so it teaches like one.
    await learnFromDecision({
      profileId: profile.id,
      job: {
        title: lead.title,
        descriptionText: lead.descriptionText ?? '',
        location: lead.location ?? undefined,
      },
      accepted: true,
    });
    await rescoreLexically(profile.id);

    return { applicationId: application.id };
  });

  /** Shortlist and immediately start an application run. */
  app.post<{ Params: { id: string } }>('/api/leads/:id/apply', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { requiresReview } = z
      .object({ requiresReview: z.boolean().default(true) })
      .parse(req.body ?? {});

    const lead = await ownedLead(profile.id, req.params.id);
    if (!lead) return reply.code(404).send({ error: 'Not found' });

    const adapter = adapterFor(lead.url);
    const job = await prisma.job.upsert({
      where: { url: lead.url },
      create: {
        url: lead.url,
        ats: adapter.id,
        company: lead.companyName,
        title: lead.title,
        location: lead.location,
        descriptionText: lead.descriptionText,
      },
      update: { descriptionText: lead.descriptionText ?? undefined },
    });

    const application = await prisma.application.upsert({
      where: { profileId_jobId: { profileId: profile.id, jobId: job.id } },
      create: { profileId: profile.id, jobId: job.id, requiresReview },
      update: { status: 'QUEUED', blockedReason: null, requiresReview },
    });

    await prisma.jobLead.update({
      where: { id: lead.id },
      data: { status: 'APPLIED', applicationId: application.id, decidedAt: new Date() },
    });
    await learnFromDecision({
      profileId: profile.id,
      job: {
        title: lead.title,
        descriptionText: lead.descriptionText ?? '',
        location: lead.location ?? undefined,
      },
      accepted: true,
    });

    await rescoreLexically(profile.id);
    enqueue(application.id);
    return { applicationId: application.id };
  });

  // ----------------------------------------------- what it has learned so far ---

  app.get('/api/preferences', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const signals = await prisma.preferenceSignal.findMany({
      where: { profileId: profile.id },
      orderBy: { weight: 'desc' },
    });
    return {
      likes: signals.filter((s) => s.weight > 0.2).slice(0, 40),
      dislikes: signals.filter((s) => s.weight < -0.2).reverse().slice(0, 40),
      total: signals.length,
    };
  });

  app.delete<{ Params: { id: string } }>('/api/preferences/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const signal = await ownedSignal(profile.id, req.params.id);
    if (!signal) return reply.code(404).send(NOT_YOURS);
    await prisma.preferenceSignal.delete({ where: { id: signal.id } });
    return { ok: true };
  });

  /** Manually tell it something, instead of waiting for it to infer. */
  app.post('/api/preferences', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { term, weight } = z
      .object({ term: z.string().min(1), weight: z.number().min(-4).max(4) })
      .parse(req.body);
    const signal = await prisma.preferenceSignal.upsert({
      where: { profileId_term: { profileId: profile.id, term: term.toLowerCase().trim() } },
      create: { profileId: profile.id, term: term.toLowerCase().trim(), weight, origin: 'STATED' },
      update: { weight, origin: 'STATED' },
    });
    return { signal, total: (await loadSignals(profile.id)).size };
  });
}

export type RequireProfile = (
  req: { headers: { cookie?: string } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => Promise<{ id: string } | null>;
