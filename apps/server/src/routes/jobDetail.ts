import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import type { RequireProfile } from './discovery.js';
import { canonicalUrl } from '../discovery/findJobs.js';

/**
 * One job, everything about it, on one screen.
 *
 * The app grew feature by feature and each one got its own page, which left
 * the thing they all describe - a single job at a single company - scattered
 * across five of them. The score lived in Discover, the filled form in Runs,
 * the tailored resume in Resume, the interview rounds in Tracker, and the
 * lessons in Retrospective. Answering "how is the Stripe application going?"
 * meant visiting all five and joining them in your head.
 *
 * So this endpoint does the join. It takes a lead id or an application id -
 * you should not have to know which of those you are holding - and returns the
 * job with everything hanging off it, plus the single next action, because
 * that is the question you actually came to ask.
 */

interface Reason {
  verdict?: string;
  seniorityFit?: string;
  forIt?: string[];
  againstIt?: string[];
  dealbreaker?: string;
  likedTerms?: string[];
  dislikedTerms?: string[];
  lexicalScore?: number;
}

interface PlanEntry {
  label?: string;
  value?: unknown;
  source?: string;
  confidence?: number;
  filled?: boolean;
  error?: string;
}

export function registerJobDetailRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const found = await locate(profile.id, req.params.id);
    if (!found) return reply.code(404).send({ error: 'No job, lead or application with that id.' });

    const { lead, application } = found;

    // The job itself can come from either side; a lead that was never applied
    // to has no Job row, and an application from a pasted URL has no lead.
    const job = application?.job;
    const identity = {
      title: lead?.title ?? job?.title ?? 'Untitled role',
      company: lead?.companyName ?? job?.company ?? '',
      location: lead?.location ?? job?.location ?? null,
      remote: lead?.remote ?? false,
      url: lead?.url ?? job?.url ?? '',
      ats: lead?.ats ?? job?.ats ?? 'generic',
      postedAt: lead?.postedAt ?? null,
      descriptionText: lead?.descriptionText ?? job?.descriptionText ?? null,
    };

    const reasons = (lead?.scoreReasons ?? null) as Reason | null;

    const tailored = application?.tailoredResumeId
      ? await prisma.tailoredResume.findUnique({ where: { id: application.tailoredResumeId } })
      : null;

    const plan = (application?.fieldPlan ?? []) as PlanEntry[];

    return {
      job: identity,
      match: lead
        ? {
            score: Math.round(lead.score),
            deepScored: lead.deepScored,
            verdict: reasons?.verdict ?? null,
            seniorityFit: reasons?.seniorityFit ?? null,
            forIt: reasons?.forIt ?? [],
            againstIt: reasons?.againstIt ?? [],
            dealbreaker: reasons?.dealbreaker || null,
            likedTerms: reasons?.likedTerms ?? [],
            dislikedTerms: reasons?.dislikedTerms ?? [],
          }
        : null,
      lead: lead
        ? {
            id: lead.id,
            status: lead.status,
            rejectReason: lead.rejectReason,
            rejectCategory: lead.rejectCategory,
            discoveredAt: lead.discoveredAt,
          }
        : null,
      application: application
        ? {
            id: application.id,
            status: application.status,
            blockedReason: application.blockedReason,
            outcome: application.outcome,
            outcomeAt: application.outcomeAt,
            outcomeNote: application.outcomeNote,
            submittedAt: application.submittedAt,
            confirmation: application.confirmation,
            notes: application.notes,
            coverLetter: application.coverLetter
              ? { present: true, words: countWords(application.coverLetter) }
              : { present: false, words: 0 },
            resume: tailored
              ? {
                  tailored: true,
                  label: tailored.label,
                  coverage: Math.round(tailored.coverage),
                  insertions: (tailored.insertions as unknown[] | null)?.length ?? 0,
                  // The number that matters, and the reason the tailor exists:
                  // keywords the job wanted that could not be grounded were
                  // left out rather than written in.
                  unsupported: (tailored.unsupported as unknown[] | null)?.length ?? 0,
                }
              : { tailored: false },
            fields: summariseFields(plan, application.pending),
          }
        : null,
      rounds: (application?.rounds ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        sequence: r.sequence,
        status: r.status,
        format: r.format,
        scheduledAt: r.scheduledAt,
        completedAt: r.completedAt,
        interviewers: r.interviewers,
        notes: r.notes,
        questions: r.questions.map((q) => ({
          id: q.id,
          question: q.question,
          myAnswer: q.myAnswer,
          selfRating: q.selfRating,
          category: q.category,
        })),
      })),
      lessons: (application?.lessons ?? []).map((l) => ({
        id: l.id,
        text: l.text,
        category: l.category,
        roundId: l.roundId,
      })),
      nextAction: nextAction(lead, application),
    };
  });
}

/**
 * Find the job from whatever id you have.
 *
 * A link from the queue carries a lead id, one from a run carries an
 * application id, and the URL a person copies could be either. Rather than
 * making the caller know, this tries both and then pulls in the other side.
 */
const FULL = {
  job: true,
  pending: true,
  rounds: { include: { questions: true }, orderBy: { sequence: 'asc' as const } },
  lessons: true,
};

/**
 * The id in the URL can name a lead or an application; either way it has to be
 * the caller's own. Scoped at every lookup rather than checked once at the
 * end, so no branch through here can return a stranger's row.
 */
async function locate(profileId: string, id: string) {
  const lead = await prisma.jobLead.findFirst({ where: { id, profileId } });
  if (lead) {
    const application = lead.applicationId
      ? await prisma.application.findFirst({
          where: { id: lead.applicationId, profileId },
          include: FULL,
        })
      : // A lead applied to before applicationId was linked, or linked by URL
        // alone: match on the job's canonical URL rather than losing the join.
        await findApplicationByUrl(profileId, lead.url);
    return { lead, application };
  }

  const application = await prisma.application.findFirst({ where: { id, profileId }, include: FULL });
  if (!application) return null;

  const byId = await prisma.jobLead.findFirst({ where: { applicationId: application.id } });
  const byUrl =
    byId ??
    (await prisma.jobLead.findFirst({
      where: { profileId: application.profileId, url: application.job.url },
    }));
  return { lead: byUrl, application };
}

async function findApplicationByUrl(profileId: string, url: string) {
  let job = await prisma.job.findFirst({ where: { url } });
  if (!job) {
    // Try the canonical form too: a lead stored from search and a job created
    // from a pasted URL can differ by scheme or a tracking parameter, and
    // failing the join would silently show an applied job as untouched.
    const canonical = canonicalUrl(url);
    const all = await prisma.job.findMany({ select: { id: true, url: true } });
    const hit = all.find((j) => canonicalUrl(j.url) === canonical);
    if (!hit) return null;
    job = await prisma.job.findUnique({ where: { id: hit.id } });
    if (!job) return null;
  }
  return prisma.application.findFirst({ where: { jobId: job.id, profileId }, include: FULL });
}

/**
 * Where the answers came from.
 *
 * The whole promise of this app is that it does not make things up, and this
 * is where that becomes visible per application: how many fields came straight
 * from the profile, how many from remembered answers, how many were written
 * for this employer, and how many it stopped and asked about.
 */
function summariseFields(plan: PlanEntry[], pending: { answeredAt: Date | null }[]) {
  const bySource: Record<string, number> = {};
  for (const entry of plan) {
    const source = entry.source ?? 'UNKNOWN';
    bySource[source] = (bySource[source] ?? 0) + 1;
  }
  const unanswered = pending.filter((p) => !p.answeredAt).length;
  return {
    total: plan.length,
    fromProfile: (bySource.PROFILE ?? 0) + (bySource.RULE ?? 0),
    fromMemory: bySource.MEMORY ?? 0,
    written: (bySource.GENERATED ?? 0) + (bySource.ESSAY ?? 0),
    inferred: bySource.INFERRED ?? 0,
    asked: bySource.ASKED ?? 0,
    skipped: bySource.SKIPPED ?? 0,
    failed: plan.filter((p) => p.error).length,
    needsYou: unanswered,
  };
}

/**
 * The one thing to do next.
 *
 * Ordered by what actually blocks progress, not by what is most interesting:
 * a question waiting on a human beats a resume you could tailor.
 */
function nextAction(
  lead: { id: string; status: string } | null,
  application: { id: string; status: string; outcome: string } | null,
): { label: string; href: string; urgent: boolean } | null {
  if (application) {
    switch (application.status) {
      case 'NEEDS_INPUT':
        return { label: 'Answer the question', href: `/applications/${application.id}`, urgent: true };
      case 'REVIEW':
        return { label: 'Review and submit', href: `/applications/${application.id}`, urgent: true };
      case 'NEEDS_HUMAN':
        return { label: 'Take over in the browser', href: `/applications/${application.id}`, urgent: true };
      // The four in-flight states. Named explicitly rather than left to the
      // default, because "watch it run" and "open the run" say different
      // things about whether anything is happening.
      case 'QUEUED':
      case 'PREPARING':
      case 'FILLING':
      case 'SUBMITTING':
        return { label: 'Watch it run', href: `/applications/${application.id}`, urgent: false };
      case 'SUBMITTED':
        return application.outcome === 'IN_PROGRESS'
          ? { label: 'Log what happened next', href: '/tracker', urgent: false }
          : null;
      default:
        return { label: 'Open the run', href: `/applications/${application.id}`, urgent: false };
    }
  }
  if (lead && lead.status === 'NEW') {
    return { label: 'Triage this lead', href: '/discover', urgent: false };
  }
  if (lead && lead.status === 'SHORTLISTED') {
    return { label: 'Apply', href: '/discover', urgent: false };
  }
  return null;
}

const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
