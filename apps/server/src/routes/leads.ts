import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Prisma } from '../lib/db.js';
import { learnFromDecision } from '../discovery/scoring.js';
import { rescoreByIds, rescoreLexically } from '../discovery/rescoreLeads.js';
import { NOT_YOURS, ownedLead } from '../auth/ownership.js';
import { adapterFor } from '../ats/registry.js';
import { enqueue } from '../engine/queue.js';
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
    /** Filter out staff-level and above seniority jobs */
    excludeStaff: z.boolean().default(false),
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
    
    // Filter out staff-level and above seniority jobs if requested
    if (query.excludeStaff) {
      // Filter in memory since Prisma doesn't support multiple NOT conditions well
      const seniorityPatterns = ['staff', 'principal', 'director', 'vp', 'head of', 'chief', 'cto', 'manager'];
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

    // Filter out staff-level and above seniority jobs if requested
    let filteredLeads = leads;
    if (query.excludeStaff) {
      const seniorityPatterns = ['staff', 'principal', 'director', 'vp', 'head of', 'chief', 'cto', 'manager'];
      filteredLeads = leads.filter(lead => {
        const titleLower = lead.title.toLowerCase();
        // Filter by title patterns
        if (seniorityPatterns.some(pattern => titleLower.includes(pattern))) {
          return false;
        }
        // Filter by experience requirements in description
        if (lead.descriptionText) {
          const descLower = lead.descriptionText.toLowerCase();
          const experiencePatterns = [
            /(\d+)\+?\s*years?\s*(of\s*)?(experience|work)/i,
            /(\d+)\s*years?\s*\+\s*(of\s*)?(experience|work)/i,
          ];
          for (const pattern of experiencePatterns) {
            const match = descLower.match(pattern);
            if (match && match[1]) {
              const years = parseInt(match[1], 10);
              if (years > 5) return false;
            }
          }
        }
        return true;
      });
    }

    return {
      // The description is large and the list view never shows it in full.
      leads: filteredLeads.map((l) => ({ ...l, descriptionText: l.descriptionText?.slice(0, 600) ?? null })),
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
          const result = await tailorResume({
            candidateContext: renderCandidateContext(full, resumeText),
            resumeText,
            jobTitle: lead.title,
            companyName: lead.companyName,
            jobDescription: lead.descriptionText,
          });

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
        // Don't fail the application if tailoring fails, just log it
        console.error('Auto-tailor resume failed:', err);
      }
    }

    enqueue(application.id);
    return { applicationId: application.id, tailoredResumeId };
  });
}
