import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Prisma } from '../lib/db.js';
import { listLeads } from '../discovery/leadListing.js';
import { learnFromDecision } from '../discovery/scoring.js';
import { rescoreByIds, rescoreLexically } from '../discovery/rescoreLeads.js';
import { NOT_YOURS, ownedLead } from '../auth/ownership.js';
import { adapterFor } from '../ats/registry.js';
import { enqueue } from '../engine/queue.js';
import { bus } from '../lib/events.js';
import { tailorResume } from '../resume/tailor.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { renderResume } from '../resume/render.js';
import type { RequireProfile } from './types.js';

/**
 * How many leads one "rescore selected" press may read.
 *
 * Each one is a model call taking seconds, run in series, and the browser is
 * holding the request open the whole time. Twenty-five is about a minute of
 * waiting, which is the most a button press should ever ask for.
 */
export const MAX_RESCORE_BATCH = 25;

/** How long an application waits on resume tailoring before starting without it. */
const TAILOR_TIMEOUT_MS = 90_000;

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
    const { requiresReview, writeCoverLetter, autoTailorResume } = z
      .object({
        requiresReview: z.boolean().default(true),
        // Off unless asked for. Most applications do not need one.
        writeCoverLetter: z.boolean().default(false),
        // Automatically tailor resume for this job
        autoTailorResume: z.boolean().default(true),
      })
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
      create: { profileId: profile.id, jobId: job.id, requiresReview, writeCoverLetter },
      update: { status: 'QUEUED', blockedReason: null, requiresReview, writeCoverLetter },
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

    // Auto-tailor resume if requested
    let tailoredResumeId: string | null = null;
    if (autoTailorResume && lead.descriptionText && lead.descriptionText.length >= 200) {
      try {
        const full = await prisma.profile.findUniqueOrThrow({
          where: { id: profile.id },
          include: { facts: true, resumes: true },
        });

        const base =
          full.resumes.find((r) => r.isDefault) ??
          full.resumes[0];
        const resumeText = base?.text ?? full.resumeText;

        if (resumeText && resumeText.trim().length >= 100) {
          // The run does not start until this is done, so say so - otherwise
          // the page just reads "waiting" for as long as the model takes.
          await bus.emitEvent(application.id, 'LOG', 'Tailoring your resume for this job before starting…');
          // A slow or rate-limited model must not hold the application hostage:
          // after this long, apply with the resume you already have.
          const result = await Promise.race([
            tailorResume({
              candidateContext: renderCandidateContext(full, resumeText),
              resumeText,
              jobTitle: lead.title,
              companyName: lead.companyName,
              jobDescription: lead.descriptionText,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('took longer than 90 seconds')), TAILOR_TIMEOUT_MS),
            ),
          ]);

          const rendered = await renderResume(result.text, {
            profileName: full.fullName,
            slug: `${lead.companyName}-${lead.title}`,
          });

          const tailored = await prisma.tailoredResume.create({
            data: {
              profileId: full.id,
              jobId: job.id,
              baseResumeId: base?.id ?? 'inline',
              label: `${lead.title} at ${lead.companyName}`,
              text: result.text,
              txtPath: rendered.txtPath,
              docxPath: rendered.docxPath,
              insertions: result.insertions as unknown as Prisma.InputJsonValue,
              unsupported: result.unsupported as unknown as Prisma.InputJsonValue,
              covered: result.covered as unknown as Prisma.InputJsonValue,
              coverage: result.coverage,
            },
          });

          // Attach the tailored resume to the application
          await prisma.application.update({
            where: { id: application.id },
            data: { tailoredResumeId: tailored.id },
          });

          tailoredResumeId = tailored.id;
        }
      } catch (err) {
        // Don't fail the application if tailoring fails; say so and carry on.
        console.error('Auto-tailor resume failed:', err);
        await bus.emitEvent(
          application.id,
          'LOG',
          `Resume tailoring skipped (${(err as Error).message}). Applying with your default resume.`,
        );
      }
    }

    enqueue(application.id);
    return { applicationId: application.id, tailoredResumeId };
  });
}
