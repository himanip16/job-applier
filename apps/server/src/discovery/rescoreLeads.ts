import { prisma, type Prisma } from '../lib/db.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import {
  assessFit,
  blendScores,
  buildPreferences,
  buildRejectionHistory,
  loadScoringContext,
  scoreLexically,
  serialiseReasons,
} from './scoring.js';
import { applyHardRules, candidateConstraints } from './hardRules.js';
import { wrongDomain } from './leadCleanup.js';


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

/**
 * Below this, a lead is deleted rather than kept and ranked last.
 *
 * Deleting on a cheap keyword score is a strong action taken on weak
 * evidence, so the bar is set at the bottom of the observed distribution
 * rather than at the midpoint - see the note at the call site.
 */
const PRUNE_BELOW = 40;

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

  const [preferences, rejectionHistory, scoring] = await Promise.all([
    buildPreferences(profileId),
    buildRejectionHistory(profileId),
    loadScoringContext(profileId),
  ]);
  const candidateContext = renderCandidateContext(profile, profile.resumeText);
  const constraints = candidateConstraints(profile);

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
      const raw = await assessFit({ candidateContext, preferences, rejectionHistory, job });
      if (!raw) {
        outcomes.push({ id: lead.id, ok: false, reason: 'declined', error: DECLINED_MESSAGE });
        continue;
      }
      const fit = applyHardRules(raw, { 
        candidateYears: constraints.candidateYears, 
        needsSponsorship: constraints.needsSponsorship,
        salaryExpectations: constraints.salaryExpectations,
        currentCTC: constraints.currentCTC,
        job 
      });
      const lex = scoreLexically(job, scoring);
      const blended = blendScores(fit, lex);
      
      // Auto-reject leads with deep score below 55
      const shouldAutoReject = blended < 55;
      
      await prisma.jobLead.update({
        where: { id: lead.id },
        data: {
          score: blended,
          scoreReasons: serialiseReasons(lex, fit) as Prisma.InputJsonValue,
          deepScored: true,
          scoredAt: new Date(),
          ...(shouldAutoReject && {
            status: 'REJECTED',
            decidedAt: new Date(),
            rejectReason: 'Auto-rejected: deep score below 55',
          }),
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

/**
 * Re-apply the lexical score to every undecided lead.
 *
 * Called immediately after each decision, because the whole promise of the
 * triage queue is that rejecting one job re-ranks the ones like it. Without
 * this, the sibling posting two rows down keeps the score it was crawled with
 * and the learning is invisible until the next crawl.
 *
 * Free to run: no network, no model, and a queue is tens of rows.
 *
 * Leads that have had a model read keep it - their score is a blend the model
 * dominates, so re-deriving it from word counts alone would be a downgrade.
 * Their lexical component is refreshed on the next full rescore instead.
 */
export async function rescoreLexically(profileId: string): Promise<number> {
  const scoring = await loadScoringContext(profileId);
  let pruned = 0;
  const leads = await prisma.jobLead.findMany({
    where: { profileId, status: 'NEW', deepScored: false },
  });

  let updated = 0;
  for (const lead of leads) {
    const lex = scoreLexically(
      {
        title: lead.title,
        descriptionText: lead.descriptionText ?? '',
        location: lead.location ?? undefined,
      },
      scoring,
    );

    // Drop the genuinely hopeless so the queue stays a queue.
    //
    // This threshold arrived as 45, which was safe only while every
    // lexical score was 50: nothing was ever below it, so nothing was ever
    // deleted. Now that the score actually reflects the resume, a real
    // backend job with a terse title lands in the twenties - Mercury's own
    // "Senior Software Engineer - Mercury Command" scores 27 - and 45 would
    // permanently delete most of a healthy queue on every crawl. Fifteen is
    // where the honest bottom of the distribution sits: marketing, support
    // and compliance postings for a backend engineer.
    //
    // Moved to Dismissed, never deleted: nothing in the app removes your data
    // on its own. A lead you disagree with is one tab away.
    //
    // And only a role the rules already say is not engineering. A keyword
    // score alone must never dismiss a real engineering job: "Senior Data
    // Engineer" scored 8 once the filler words stopped counting.
    if (lex.score < PRUNE_BELOW && wrongDomain(lead.title)) {
      await prisma.jobLead
        .update({
          where: { id: lead.id },
          data: {
            status: 'REJECTED',
            score: lex.score,
            scoreReasons: serialiseReasons(lex, null),
            scoredAt: new Date(),
            decidedAt: new Date(),
            rejectCategory: 'Wrong domain',
            rejectReason: `Auto-dismissed: not a software engineering role (${wrongDomain(lead.title)}).`,
          },
        })
        .catch(() => {});
      pruned++;
      continue;
    }

    await prisma.jobLead.update({
      where: { id: lead.id },
      data: {
        score: lex.score,
        scoreReasons: serialiseReasons(lex, null),
        scoredAt: new Date(),
      },
    });
    updated++;
  }
  if (pruned) process.stdout.write(`[discovery] moved ${pruned} hopeless lead(s) to Dismissed\n`);
  return updated;
}
