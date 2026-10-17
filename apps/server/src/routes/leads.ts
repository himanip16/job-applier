import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { listLeads } from '../discovery/leadListing.js';
import { backCheck } from '../discovery/backCheck.js';
import { learnFromDecision } from '../discovery/scoring.js';
import { rescoreByIds, rescoreLexically } from '../discovery/rescoreLeads.js';
import { NOT_YOURS, ownedLead } from '../auth/ownership.js';
import { adapterFor } from '../ats/registry.js';
import { activeRuns, enqueue, queuedRuns } from '../engine/queue.js';
import { CONCURRENCY } from '../engine/slots.js';
import { TAILOR_LATER_NOTE, tailorForApplication } from '../engine/tailorForApplication.js';
import { bus } from '../lib/events.js';
import type { RequireProfile } from './types.js';

/**
 * How many leads one "rescore selected" press may read.
 *
 * Each one is a model call taking seconds, run in series, and the browser is
 * holding the request open the whole time. Twenty-five is about a minute of
 * waiting, which is the most a button press should ever ask for.
 */
export const MAX_RESCORE_BATCH = 25;

/** The most jobs one bulk apply queues. Queueing is quick; the runs are not. */
export const MAX_APPLY_BATCH = 500;

export function registerLeadRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
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

  const flag = z.enum(['true', 'false', '1', '0']).optional().transform((v) => v === 'true' || v === '1');
  const optionalNumber = z.preprocess((v) => (v === '' || v === undefined ? undefined : v), z.coerce.number().min(0).optional());
  const LeadQuery = z.object({
    status: z.string().default('NEW'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.enum(['recommended', 'score', 'pay', 'hiring', 'posted', 'discovered']).catch('recommended'),
    q: z.string().trim().default(''),
    remote: z.enum(['any', 'yes', 'no']).default('any'),
    minScore: optionalNumber,
    depth: z.enum(['any', 'deep', 'quick']).default('any'),
    postedWithin: optionalNumber,
    country: z.string().length(2).optional().or(z.literal('').transform(() => undefined)),
    city: z.string().optional(),
    company: z.string().optional(),
    // Repeated in the query string, one per company; a single one arrives as a string.
    notCompanies: z.union([z.string(), z.array(z.string())]).optional()
      .transform((v) => (v === undefined ? [] : [v].flat().filter(Boolean))),
    tier: z.string().optional(),
    minPay: optionalNumber,
    autoApply: flag,
    excludeSenior: flag,
    hiring: flag,
    maxYears: optionalNumber,
  });

  app.get('/api/leads', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const query = LeadQuery.parse(req.query ?? {});
    const result = await listLeads(profile.id, { ...query, city: query.city || undefined, company: query.company || undefined, tier: query.tier || undefined });
    // A posting that has closed since it was found is not listed: the shown
    // cards are back-checked, and the ones found closed are removed.
    if (query.status === 'NEW' || query.status === 'SHORTLISTED') {
      const closed = await backCheck(profile.id, result.leads);
      if (closed.size) {
        result.leads = result.leads.filter((l) => !closed.has(l.id));
        result.total = Math.max(0, result.total - closed.size);
      }
    }
    return {
      ...result,
      maxRescoreBatch: MAX_RESCORE_BATCH,
      // The same numbers under the shape the first paginated build returned,
      // so nothing that already reads `pagination` breaks on the way past.
      pagination: { page: result.page, pageSize: result.limit, total: result.total, totalPages: result.pages },
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
    // Learn from the candidate's decision, then move the lead to Dismissed.
    // Kept, not deleted: the row is how the next crawl knows this posting was
    // already turned down. Deleting it made every crawl offer it again.
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

    await prisma.jobLead.update({
      where: { id: lead.id },
      data: { status: 'REJECTED', rejectReason: reason?.trim() || null, rejectCategory: category || null, decidedAt: new Date() },
    });
    // Re-rank what remains so the effect of the decision is visible now.
    const reranked = await rescoreLexically(profile.id);
    return { ok: true, reranked, message: `Dismissed lead and re-ranked ${reranked} remaining lead(s).` };
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

  const applyOptions = z.object({
    requiresReview: z.boolean().default(true),
    // Off unless asked for. Most applications do not need one.
    writeCoverLetter: z.boolean().default(false),
    // Automatically tailor resume for this job
    autoTailorResume: z.boolean().default(true),
  });

  /**
   * Turn a lead into a QUEUED application, without starting it. Returns an
   * error and status code instead when it cannot be applied to.
   */
  async function prepareApplication(
    profileId: string,
    leadId: string,
    opts: { requiresReview: boolean; writeCoverLetter: boolean },
  ): Promise<
    | { applicationId: string; alreadyRunning?: boolean }
    | { code: number; error: string; applicationId?: string; submittedAt?: Date | null }
  > {
    const lead = await ownedLead(profileId, leadId);
    if (!lead) return { code: 404, error: 'Not found' };

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

    const already = await prisma.application.findUnique({
      where: { profileId_jobId: { profileId, jobId: job.id } },
      select: { id: true, status: true, submittedAt: true },
    });
    if (already?.status === 'SUBMITTED') {
      return {
        code: 409,
        error: 'You already applied to this job.',
        applicationId: already.id,
        submittedAt: already.submittedAt,
      };
    }
    // Mid-run: resetting it to QUEUED would misreport a form being filled.
    if (already && activeRuns().includes(already.id)) return { applicationId: already.id, alreadyRunning: true };

    const { requiresReview, writeCoverLetter } = opts;
    const application = await prisma.application.upsert({
      where: { profileId_jobId: { profileId, jobId: job.id } },
      create: { profileId, jobId: job.id, requiresReview, writeCoverLetter },
      update: { status: 'QUEUED', blockedReason: null, requiresReview, writeCoverLetter },
    });

    await prisma.jobLead.update({
      where: { id: lead.id },
      // Processing (Saved with a run attached), not Applied: the run has only
      // started. syncLead moves it on when the run ends.
      data: { status: 'SHORTLISTED', applicationId: application.id, decidedAt: new Date() },
    });
    await learnFromDecision({
      profileId,
      job: {
        title: lead.title,
        descriptionText: lead.descriptionText ?? '',
        location: lead.location ?? undefined,
      },
      accepted: true,
    });
    return { applicationId: application.id };
  }

  /** Start an application run. The card sits in Processing until it submits. */
  app.post<{ Params: { id: string } }>('/api/leads/:id/apply', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { requiresReview, writeCoverLetter, autoTailorResume } = applyOptions.parse(req.body ?? {});

    const prepared = await prepareApplication(profile.id, req.params.id, { requiresReview, writeCoverLetter });
    if ('code' in prepared) {
      const { code, ...body } = prepared;
      return reply.code(code).send(body);
    }
    if (prepared.alreadyRunning) return { applicationId: prepared.applicationId, tailoredResumeId: null };

    await rescoreLexically(profile.id);

    // One job: tailor now, so the tab that opens shows the run with its resume.
    const tailoredResumeId = autoTailorResume ? await tailorForApplication(prepared.applicationId) : null;

    enqueue(prepared.applicationId);
    return { applicationId: prepared.applicationId, tailoredResumeId };
  });

  /**
   * Apply to many jobs in one go. Everything is queued here, on the server,
   * before this returns - the page can be closed straight after - and the
   * queue works through them RUN_CONCURRENCY at a time. Each tailors its
   * resume when its turn comes, not now.
   */
  app.post('/api/leads/apply-bulk', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { ids, requiresReview, writeCoverLetter, autoTailorResume } = applyOptions
      .extend({ ids: z.array(z.string().min(1)).min(1).max(MAX_APPLY_BATCH) })
      .parse(req.body ?? {});

    const queued: Array<{ id: string; applicationId: string }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of [...new Set(ids)]) {
      try {
        const prepared = await prepareApplication(profile.id, id, { requiresReview, writeCoverLetter });
        if ('code' in prepared) {
          failed.push({ id, error: prepared.error });
          continue;
        }
        if (!prepared.alreadyRunning) {
          if (autoTailorResume) await bus.emitEvent(prepared.applicationId, 'LOG', TAILOR_LATER_NOTE);
          enqueue(prepared.applicationId, { tailor: autoTailorResume });
        }
        queued.push({ id, applicationId: prepared.applicationId });
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }

    // Once for the batch, not once per job: it re-reads every unscored lead.
    void rescoreLexically(profile.id).catch(() => {});
    return { queued, failed, concurrency: CONCURRENCY, waiting: queuedRuns().length };
  });
}
