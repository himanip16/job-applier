import { prisma, type Prisma } from '../lib/db.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import {
  assessFit,
  assessFitBatch,
  blendScores,
  buildPreferences,
  buildRejectionHistory,
  loadScoringContext,
  scoreLexically,
  serialiseReasons,
} from './scoring.js';
import { applyHardRules, extractCandidateConstraints } from './hardRules.js';


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
 *
 * Strong matches are never pruned out of the queue; they are explicitly
 * re-evaluated so a good lead keeps a chance to be revisited rather than being
 * silently dropped on a stale lexical read.
 */
const PRUNE_BELOW = 15;
const STRONG_MATCH_THRESHOLD = 70;

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
  const constraints = extractCandidateConstraints(profile);

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
        job 
      });
      const lex = scoreLexically(job, scoring);
      const blended = blendScores(fit, lex);
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
 * Score leads using batch LLM calls to reduce the number of API calls.
 * This is more efficient when rescoring many jobs at once.
 */
export async function rescoreLeadsBatch(profileId: string, leads: Lead[]): Promise<RescoreOutcome[]> {
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
  const constraints = extractCandidateConstraints(profile);

  // Filter out leads without descriptions
  const validLeads = leads.filter(l => l.descriptionText);
  const withoutDesc = leads.filter(l => !l.descriptionText);
  
  const outcomes: RescoreOutcome[] = withoutDesc.map(lead => ({
    id: lead.id,
    ok: false,
    reason: 'no-description' as const,
    error: NO_DESCRIPTION_MESSAGE,
  }));

  if (!validLeads.length) return outcomes;

  // Process in batches of 5 to balance between single-call efficiency and token limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < validLeads.length; i += BATCH_SIZE) {
    const batch = validLeads.slice(i, i + BATCH_SIZE);
    const jobs = batch.map(lead => ({
      title: lead.title,
      companyName: lead.companyName,
      location: lead.location ?? undefined,
      descriptionText: lead.descriptionText ?? '', // Ensure string, not null
      remote: lead.remote,
    }));

    // Track which leads were successfully processed in batch to avoid duplicates in fallback
    const processedLeadIds = new Set<string>();

    try {
      const assessments = await assessFitBatch({
        candidateContext,
        preferences,
        rejectionHistory,
        jobs
      });

      for (let j = 0; j < batch.length; j++) {
        const lead = batch[j];
        if (!lead) continue;
        
        // Bounds check: ensure assessments has enough items
        if (j >= assessments.length) {
          outcomes.push({ id: lead.id, ok: false, reason: 'failed', error: 'Assessment missing for this lead' });
          continue;
        }
        
        const raw = assessments[j];

        if (!raw) {
          outcomes.push({ id: lead.id, ok: false, reason: 'declined', error: DECLINED_MESSAGE });
          processedLeadIds.add(lead.id);
          continue;
        }

        const job = jobs[j];
        if (!job) {
          outcomes.push({ id: lead.id, ok: false, reason: 'failed', error: 'Job data missing' });
          processedLeadIds.add(lead.id);
          continue;
        }

        const fit = applyHardRules(raw, {
          candidateYears: constraints.candidateYears,
          needsSponsorship: constraints.needsSponsorship,
          salaryExpectations: constraints.salaryExpectations,
          job
        });
        const lex = scoreLexically(job, scoring);
        const blended = blendScores(fit, lex);

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
        processedLeadIds.add(lead.id);
      }
    } catch (err) {
      // If batch fails, fall back to individual scoring for this batch
      console.error('Batch scoring failed for batch, falling back to individual:', err);
      for (const lead of batch) {
        // Skip leads that were already processed before the batch failed
        if (processedLeadIds.has(lead.id)) {
          continue;
        }

        const job = {
          title: lead.title,
          companyName: lead.companyName,
          location: lead.location ?? undefined,
          descriptionText: lead.descriptionText ?? '', // Ensure string, not null
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
            job
          });
          const lex = scoreLexically(job, scoring);
          const blended = blendScores(fit, lex);
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
        } catch (innerErr) {
          outcomes.push({ id: lead.id, ok: false, reason: 'failed', error: (innerErr as Error).message });
        }
      }
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
    // Strong matches are explicitly re-evaluated instead of being pruned out on
    // a stale lexical pass. If a lead was already a standout, keep it alive to
    // be reconsidered and scored again.
    const isStrongMatch = (lead.score ?? 0) >= STRONG_MATCH_THRESHOLD;
    if (!isStrongMatch && lex.score < PRUNE_BELOW) {
      await prisma.jobLead.delete({ where: { id: lead.id } }).catch(() => {});
      pruned++;
      continue;
    }

    await prisma.jobLead.update({
      where: { id: lead.id },
      data: {
        score: lex.score,
        scoreReasons: serialiseReasons(lex, null),
        deepScored: false,
        scoredAt: new Date(),
      },
    });
    updated++;
  }
  if (pruned) process.stdout.write(`[discovery] pruned ${pruned} hopeless lead(s)\n`);
  return updated;
}

/**
 * Cleanup old leads based on various criteria.
 *
 * This provides a way to clean up the leads queue by removing old, low-scoring,
 * or otherwise unwanted leads. Useful for maintaining a clean and relevant queue.
 */
export interface CleanupOptions {
  /** Only clean up leads older than this many days */
  olderThanDays?: number;
  /** Only clean up leads with this status */
  status?: 'NEW' | 'SHORTLISTED' | 'REJECTED' | 'APPLIED' | 'EXPIRED' | 'ALL';
  /** Only clean up leads with score below this threshold */
  maxScore?: number;
  /** Only clean up leads that haven't been deep scored */
  quickScoreOnly?: boolean;
  /** Dry run - don't actually delete, just report what would be deleted */
  dryRun?: boolean;
}

export interface CleanupResult {
  /** Number of leads that would be/were deleted */
  deleted: number;
  /** Breakdown by status */
  byStatus: Record<string, number>;
  /** Sample of lead titles that would be/were deleted */
  samples: string[];
}

export async function cleanupLeads(profileId: string, opts: CleanupOptions = {}): Promise<CleanupResult> {
  const {
    olderThanDays = 20,
    status = 'ALL',
    maxScore = 40,
    quickScoreOnly = false,
    dryRun = false,
  } = opts;

  const where: any = { profileId };
  
  if (status !== 'ALL') {
    where.status = status;
  }
  
  if (olderThanDays > 0) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    where.discoveredAt = { lt: cutoffDate };
  }
  
  if (maxScore !== undefined) {
    // Include null scores (unscored leads) in the filter
    where.OR = [
      { score: null },
      { score: { lt: maxScore } },
    ];
  }
  
  if (quickScoreOnly) {
    where.deepScored = false;
  }

  // First, count and sample what would be deleted
  const leadsToDelete = await prisma.jobLead.findMany({
    where,
    select: { id: true, title: true, status: true },
    take: 1000, // Safety limit
  });

  const byStatus: Record<string, number> = {};
  const samples: string[] = [];
  
  for (const lead of leadsToDelete) {
    byStatus[lead.status] = (byStatus[lead.status] || 0) + 1;
    if (samples.length < 10) {
      samples.push(lead.title);
    }
  }

  if (dryRun) {
    return {
      deleted: leadsToDelete.length,
      byStatus,
      samples,
    };
  }

  // Actually delete the leads
  const deleteResult = await prisma.jobLead.deleteMany({
    where,
  });

  if (deleteResult.count > 0) {
    process.stdout.write(`[discovery] cleaned up ${deleteResult.count} old lead(s)\n`);
  }

  return {
    deleted: deleteResult.count,
    byStatus,
    samples,
  };
}
