import { prisma, type Prisma } from '../lib/db.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { type DiscoveredJob } from './sources/index.js';
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

export interface DeepScoreEntry {
  id: string;
  job: DiscoveredJob;
  lexScore: number;
}

export interface DeepScoreResult {
  deepScored: number;
  errors: { company: string; error: string }[];
}

/**
 * Deep-score the top N leads using the model.
 * 
 * This function:
 * - Loads the profile and candidate context
 * - Sorts entries by lexical score and takes the top N
 * - Calls the model to assess fit for each job
 * - Applies hard rules and blends scores
 * - Updates the leads with the new scores
 * 
 * Returns the number of leads deep-scored and any errors that occurred.
 */
export async function deepScoreLeads(
  profileId: string,
  fresh: DeepScoreEntry[],
  deepScoreTop: number,
): Promise<DeepScoreResult> {
  const result: DeepScoreResult = {
    deepScored: 0,
    errors: [],
  };

  if (fresh.length === 0 || deepScoreTop <= 0) {
    return result;
  }

  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    include: { facts: true },
  });
  
  if (!profile) {
    return result;
  }

  const candidateContext = renderCandidateContext(profile, profile.resumeText);
  const constraints = candidateConstraints(profile);
  const preferences = await buildPreferences(profileId);
  const rejectionHistory = await buildRejectionHistory(profileId);
  const scoring = await loadScoringContext(profileId);

  const shortlist = fresh.sort((a, b) => b.lexScore - a.lexScore).slice(0, deepScoreTop);
  
  for (const entry of shortlist) {
    try {
      const raw = await assessFit({
        candidateContext,
        preferences,
        rejectionHistory,
        candidateYears: constraints.candidateYears,
        job: entry.job,
      });
      
      if (!raw) continue;
      
      const fit = applyHardRules(raw, { 
        candidateYears: constraints.candidateYears, 
        needsSponsorship: constraints.needsSponsorship,
        salaryExpectations: constraints.salaryExpectations,
        currentCTC: constraints.currentCTC,
        job: entry.job 
      });
      
      const lex = scoreLexically(entry.job, scoring);
      
      // Blend, weighted toward the model - it read the description, the
      // lexical prior only saw word counts. A hard blocker overrides both.
      const blended = blendScores(fit, lex);
      
      // Ranking never changes a candidate decision. Low scores remain reviewable.
      await prisma.jobLead.update({
        where: { id: entry.id },
        data: {
          score: blended,
          scoreReasons: serialiseReasons(lex, fit) as Prisma.InputJsonValue,
          deepScored: true,
          scoredAt: new Date(),
        },
      });
      
      result.deepScored++;
    } catch (err) {
      // A scoring failure must not lose the lead; it keeps its lexical
      // score and can be re-scored later.
      result.errors.push({ company: entry.job.companyName, error: (err as Error).message });
    }
  }

  return result;
}
