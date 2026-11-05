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
import { decidedPostings, isDecided } from './alreadyDecided.js';
import { screen } from './screening.js';

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
 * Model reads per search. Each is one model call, run one after another, so
 * this is the knob between a search that finishes sooner and one that leaves
 * fewer leads on a keyword guess.
 */
export const DEFAULT_DEEP_SCORE_TOP = 25;

/** The most model reads one company gets per pass, so thirty near-identical roles cannot spend the whole budget. */
const READS_PER_COMPANY = 3;

/**
 * Read the most promising unread leads with the model.
 *
 * The pool is every lead still waiting with no read yet - not just the ones
 * this search added. A lead that missed the cut last time is still a
 * candidate, and otherwise sat on a keyword guess for good.
 *
 * Reads are not spent where they cannot change anything: leads with no
 * description to read, leads the queue hides (decided elsewhere, now too old
 * or too senior), and titles the keyword pass already capped as the wrong
 * kind of job. The rest go by keyword score, at most READS_PER_COMPANY from
 * any one company per pass, so one company posting thirty variants of a role
 * does not take every read.
 *
 * `only` limits the pool to those lead ids, with no per-company limit: a
 * search of one company should read that company's jobs.
 */
export async function deepScoreLeads(
  profileId: string,
  deepScoreTop: number,
  opts: { only?: string[] } = {},
): Promise<DeepScoreResult> {
  const result: DeepScoreResult = {
    deepScored: 0,
    errors: [],
  };

  if (deepScoreTop <= 0 || opts.only?.length === 0) {
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
  const [preferences, rejectionHistory, scoring, decided, waiting] = await Promise.all([
    buildPreferences(profileId),
    buildRejectionHistory(profileId),
    loadScoringContext(profileId),
    decidedPostings(profileId),
    prisma.jobLead.findMany({
      where: {
        profileId,
        status: 'NEW',
        deepScored: false,
        descriptionText: { not: '' },
        ...(opts.only ? { id: { in: opts.only } } : {}),
      },
      select: {
        id: true, url: true, ats: true, title: true, companyName: true, location: true,
        remote: true, descriptionText: true, postedAt: true,
      },
    }),
  ]);

  const pool: (DeepScoreEntry & { capped: boolean })[] = [];
  for (const lead of waiting) {
    if (!lead.descriptionText?.trim() || isDecided(decided, lead)) continue;
    const job: DiscoveredJob = {
      url: lead.url,
      ats: lead.ats,
      title: lead.title,
      companyName: lead.companyName,
      location: lead.location ?? undefined,
      remote: lead.remote,
      descriptionText: lead.descriptionText,
      postedAt: lead.postedAt ?? undefined,
    };
    if (screen(job, {})) continue;
    const lex = scoreLexically(job, scoring);
    pool.push({ id: lead.id, job, lexScore: lex.score, capped: !!lex.capped });
  }

  const perCompany = new Map<string, number>();
  const shortlist = pool
    .filter((e) => !e.capped)
    .sort((a, b) => b.lexScore - a.lexScore)
    .filter((e) => {
      if (opts.only) return true;
      const key = e.job.companyName.trim().toLowerCase();
      const n = perCompany.get(key) ?? 0;
      perCompany.set(key, n + 1);
      return n < READS_PER_COMPANY;
    })
    .slice(0, deepScoreTop);
  
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
