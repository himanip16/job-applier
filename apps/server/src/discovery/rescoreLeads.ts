import { prisma, type Prisma } from '../lib/db.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import {
  assessFit,
  buildPreferences,
  buildRejectionHistory,
  loadSignals,
  scoreLexically,
  serialiseReasons,
} from './scoring.js';

/**
 * Reading postings properly, one batch at a time.
 *
 * A crawl only sends its top slice to a model, so most leads carry a keyword
 * score and a list of matched words. This is the "actually look at these"
 * path, and it exists as its own module because three callers want it: the
 * single-lead button, the "rescore the ones I picked" button, and the
 * automatic top-up after a crawl.
 *
 * Doing it as a batch is not just tidiness. The candidate context, the
 * preference summary and the rejection history are identical for every lead in
 * a run and cost three queries and a resume render to build, so building them
 * once per batch rather than once per lead is most of the work saved when you
 * tick twelve boxes.
 */

/** Why a lead came back unscored. The caller maps these to status codes. */
export type RescoreFailure = 'not-found' | 'no-description' | 'declined' | 'failed';

export interface RescoreOutcome {
  id: string;
  ok: boolean;
  /** The new blended score, when it worked. */
  score?: number;
  reason?: RescoreFailure;
  /** A sentence written for a person, when it did not. */
  error?: string;
}

export const NO_DESCRIPTION_MESSAGE =
  'This lead has no description stored, so there is nothing to read. It came from a board ' +
  'whose API would not answer; open the posting itself.';

export const DECLINED_MESSAGE = 'The model declined to assess this one.';

type Lead = Awaited<ReturnType<typeof prisma.jobLead.findFirstOrThrow>>;

/**
 * Score a known set of leads with the model, in order, and report on each.
 *
 * Sequential on purpose: these are model calls, and a burst of twenty
 * parallel ones is the fastest way to earn the rate limit that the retry
 * layer then has to wait out.
 */
export async function rescoreLeads(profileId: string, leads: Lead[]): Promise<RescoreOutcome[]> {
  if (!leads.length) return [];

  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    include: { facts: true },
  });
  if (!profile) throw new Error('No profile to score against.');

  const [preferences, rejectionHistory, signals] = await Promise.all([
    buildPreferences(profileId),
    buildRejectionHistory(profileId),
    loadSignals(profileId),
  ]);
  const candidateContext = renderCandidateContext(profile, profile.resumeText);

  const outcomes: RescoreOutcome[] = [];
  for (const lead of leads) {
    if (!lead.descriptionText) {
      outcomes.push({
        id: lead.id,
        ok: false,
        reason: 'no-description',
        error: NO_DESCRIPTION_MESSAGE,
      });
      continue;
    }

    const job = {
      title: lead.title,
      companyName: lead.companyName,
      location: lead.location ?? undefined,
      descriptionText: lead.descriptionText,
      remote: lead.remote,
    };

    try {
      const fit = await assessFit({ candidateContext, preferences, rejectionHistory, job });
      if (!fit) {
        outcomes.push({ id: lead.id, ok: false, reason: 'declined', error: DECLINED_MESSAGE });
        continue;
      }
      const lex = scoreLexically(job, signals);
      const blended = fit.dealbreaker ? Math.min(fit.score, 15) : 0.7 * fit.score + 0.3 * lex.score;
      await prisma.jobLead.update({
        where: { id: lead.id },
        data: {
          score: blended,
          scoreReasons: serialiseReasons(lex, fit) as Prisma.InputJsonValue,
          deepScored: true,
          scoredAt: new Date(),
        },
      });
      outcomes.push({ id: lead.id, ok: true, score: blended });
    } catch (err) {
      // A scoring failure must never lose the lead: it keeps the lexical score
      // it already had and can be picked again.
      outcomes.push({ id: lead.id, ok: false, reason: 'failed', error: (err as Error).message });
    }
  }
  return outcomes;
}

/**
 * Rescore exactly the leads the candidate ticked.
 *
 * Ids that do not belong to this profile come back as `not-found` rather than
 * being silently dropped, so a stale page cannot make the button look like it
 * did less than it claims.
 */
export async function rescoreByIds(profileId: string, ids: string[]): Promise<RescoreOutcome[]> {
  const unique = [...new Set(ids)];
  const leads = await prisma.jobLead.findMany({ where: { id: { in: unique }, profileId } });
  const byId = new Map(leads.map((l) => [l.id, l]));

  const found = unique.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  const outcomes = await rescoreLeads(profileId, found);
  const scored = new Map(outcomes.map((o) => [o.id, o]));

  // Reported in the order they were asked for, so the UI can line results up
  // against the boxes that were ticked.
  return unique.map(
    (id) =>
      scored.get(id) ?? {
        id,
        ok: false,
        reason: 'not-found' as const,
        error: 'That job is no longer in your list.',
      },
  );
}
