import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Prisma } from '../lib/db.js';
import { API_SOURCES } from '../discovery/sources.js';
import { crawlAll, rescore, rescoreLexically } from '../discovery/crawler.js';
import { learnFromDecision, loadSignals } from '../discovery/scoring.js';
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

export function registerDiscoveryRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  // ------------------------------------------------------------- companies ---

  app.get('/api/sources', async () => ({
    sources: API_SOURCES.map((s) => ({ id: s.id, handleHint: s.handleHint })).concat([
      { id: 'careers-page', handleHint: 'full URL of the careers page to crawl' },
    ]),
    rejectCategories: REJECT_CATEGORIES,
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
    const profile = await requireProfile(reply);
    if (!profile) return;
    const { deepScoreTop, companyId } = z
      .object({ deepScoreTop: z.number().min(0).max(60).default(15), companyId: z.string().optional() })
      .parse(req.body ?? {});
    const report = await crawlAll(profile.id, { deepScoreTop, onlyCompanyId: companyId });
    return { report };
  });

  app.post('/api/discovery/rescore', async (req, reply) => {
    const profile = await requireProfile(reply);
    if (!profile) return;
    const { limit } = z.object({ limit: z.number().min(1).max(60).default(20) }).parse(req.body ?? {});
    return { rescored: await rescore(profile.id, limit) };
  });

  // ----------------------------------------------------------------- leads ---

  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/leads', async (req, reply) => {
    const profile = await requireProfile(reply);
    if (!profile) return;
    const requested = req.query.status ?? 'NEW';
    const statusFilter: Prisma.JobLeadWhereInput =
      requested === 'ALL' ? {} : { status: requested as Prisma.JobLeadWhereInput['status'] };
    const leads = await prisma.jobLead.findMany({
      where: { profileId: profile.id, ...statusFilter },
      orderBy: [{ score: 'desc' }, { discoveredAt: 'desc' }],
      take: Number(req.query.limit ?? 60),
    });
    const counts = await prisma.jobLead.groupBy({
      by: ['status'],
      where: { profileId: profile.id },
      _count: true,
    });
    return {
      // The description is large and the list view never shows it in full.
      leads: leads.map((l) => ({ ...l, descriptionText: l.descriptionText?.slice(0, 600) ?? null })),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    };
  });

  app.get<{ Params: { id: string } }>('/api/leads/:id', async (req, reply) => {
    const lead = await prisma.jobLead.findUnique({ where: { id: req.params.id } });
    if (!lead) return reply.code(404).send({ error: 'Not found' });
    return { lead };
  });

  /**
   * Reject a lead. The reason is optional on purpose: demanding one makes
   * people type "n/a" to get past the dialog, and "n/a" is worse than silence
   * because the learner treats it as signal.
   */
  app.post<{ Params: { id: string } }>('/api/leads/:id/reject', async (req, reply) => {
    const profile = await requireProfile(reply);
    if (!profile) return;
    const { reason, category } = z
      .object({ reason: z.string().optional(), category: z.string().optional() })
      .parse(req.body ?? {});

    const lead = await prisma.jobLead.findUnique({ where: { id: req.params.id } });
    if (!lead) return reply.code(404).send({ error: 'Not found' });

    await prisma.jobLead.update({
      where: { id: lead.id },
      data: {
        status: 'REJECTED',
        rejectReason: reason ?? null,
        rejectCategory: category ?? null,
        decidedAt: new Date(),
      },
    });

    const { moved } = await learnFromDecision({
      profileId: profile.id,
      job: {
        title: lead.title,
        descriptionText: lead.descriptionText ?? '',
        location: lead.location ?? undefined,
      },
      accepted: false,
      // Category and free text are both useful; the category alone still
      // carries a lot ("Location or commute" is a strong term).
      reason: [category, reason].filter(Boolean).join('. ') || undefined,
    });

    // Re-rank what is still in the queue so the effect is visible now, not
    // after the next crawl.
    const reranked = await rescoreLexically(profile.id);

    return {
      ok: true,
      learned: moved,
      reranked,
      message: moved.length
        ? `Noted. ${reranked} remaining lead${reranked === 1 ? '' : 's'} re-ranked; postings mentioning ${moved.slice(0, 3).join(', ')} now score lower.`
        : `Noted. ${reranked} remaining lead${reranked === 1 ? '' : 's'} re-ranked.`,
    };
  });

  app.post<{ Params: { id: string } }>('/api/leads/:id/shortlist', async (req, reply) => {
    const profile = await requireProfile(reply);
    if (!profile) return;
    const lead = await prisma.jobLead.findUnique({ where: { id: req.params.id } });
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

  /** Shortlist and immediately start an application run. */
  app.post<{ Params: { id: string } }>('/api/leads/:id/apply', async (req, reply) => {
    const profile = await requireProfile(reply);
    if (!profile) return;
    const { requiresReview } = z
      .object({ requiresReview: z.boolean().default(true) })
      .parse(req.body ?? {});

    const lead = await prisma.jobLead.findUnique({ where: { id: req.params.id } });
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

  app.get('/api/preferences', async (_req, reply) => {
    const profile = await requireProfile(reply);
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

  app.delete<{ Params: { id: string } }>('/api/preferences/:id', async (req) => {
    await prisma.preferenceSignal.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  /** Manually tell it something, instead of waiting for it to infer. */
  app.post('/api/preferences', async (req, reply) => {
    const profile = await requireProfile(reply);
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

export type RequireProfile = (reply: {
  code: (n: number) => { send: (b: unknown) => unknown };
}) => Promise<{ id: string } | null>;
