import { locatedIn, type Country } from '@ja/shared';
import { prisma } from '../lib/db.js';
import type { DeepScoreEntry } from './deepScore.js';
import { isSeniorLevel, isStale, requiresMoreThan5YearsExperience } from './jobFilters.js';
import { wrongDomain } from './leadCleanup.js';
import { canonicalUrl } from './jobSearchUtils.js';
import { type ScoringContext, scoreLexically, serialiseReasons } from './scoring.js';
import { titleMatchesPlan } from './searchQueries.js';
import type { DiscoveredJob } from './sources/index.js';

/**
 * The one door every discovered posting comes through on its way to the queue.
 *
 * "Find jobs" and "Re-check known boards" used to each have their own copy of
 * this loop, and they drifted: the re-check never learned about the country
 * you asked for, so it filled a Bangalore search with Toronto, Lagos and
 * "Remote - USA". Now both call this, and a rule added here applies to both.
 */

/** Why a posting was turned away, for the run's report. */
export type Rejection = 'tooOld' | 'wrongDomain' | 'tooSenior' | 'otherCountry' | 'offPlan' | 'alreadySeen';

export interface IntakeRules {
  /** Only postings in this country (or remote and open to it). */
  country?: Country;
  /** Only postings whose title matches one of these. Omit to keep every title. */
  roleTitles?: string[];
}

/** The first rule a posting breaks, or null if it may be saved. */
export function screen(job: DiscoveredJob, rules: IntakeRules): Exclude<Rejection, 'alreadySeen'> | null {
  if (isStale(job.postedAt)) return 'tooOld';
  // Sales engineers, recruiters, Workday configurators: not this job, whatever the keywords say.
  if (wrongDomain(job.title)) return 'wrongDomain';
  if (isSeniorLevel(job.title) || requiresMoreThan5YearsExperience(job.descriptionText)) return 'tooSenior';
  if (rules.roleTitles && !titleMatchesPlan(job.title, rules.roleTitles)) return 'offPlan';
  // A board lists every office. You asked for one country.
  if (rules.country && !locatedIn(job.location, job.remote, rules.country)) return 'otherCountry';
  return null;
}

export interface IntakeTally {
  saved: number;
  /** Postings that passed every rule, whether new or already known. */
  relevant: number;
  rejected: Record<Rejection, number>;
  /** A few distinct titles behind each rejection, so an over-strict rule shows itself. */
  examples: Record<Rejection, string[]>;
  errors: { where: string; error: string }[];
  /** The new leads, for the model pass over the most promising. */
  fresh: DeepScoreEntry[];
}

export const emptyTally = (): IntakeTally => ({
  saved: 0,
  relevant: 0,
  rejected: { tooOld: 0, wrongDomain: 0, tooSenior: 0, otherCountry: 0, offPlan: 0, alreadySeen: 0 },
  examples: { tooOld: [], wrongDomain: [], tooSenior: [], otherCountry: [], offPlan: [], alreadySeen: [] },
  errors: [],
  fresh: [],
});

const EXAMPLES_PER_RULE = 5;

function noteExample(examples: string[], title: string): void {
  const t = title.trim();
  if (examples.length >= EXAMPLES_PER_RULE || !t) return;
  if (examples.some((e) => e.toLowerCase() === t.toLowerCase())) return;
  examples.push(t);
}

/**
 * Everything a run needs to save leads: who for, what is already known, and
 * how to score. Built once per run, not once per posting.
 */
export interface Intake {
  profileId: string;
  rules: IntakeRules;
  scoring: ScoringContext;
  /** Canonical URLs already in the queue, decided or not. Grows as leads are saved. */
  known: Set<string>;
}

export async function openIntake(profileId: string, rules: IntakeRules, scoring: ScoringContext): Promise<Intake> {
  const rows = await prisma.jobLead.findMany({ where: { profileId }, select: { url: true } });
  return { profileId, rules, scoring, known: new Set(rows.map((l) => canonicalUrl(l.url))) };
}

/**
 * Screen one company's postings and save the survivors as leads.
 *
 * A lead already in the queue is never re-created: re-offering a job someone
 * rejected last week is how a triage queue stops being used.
 */
export async function admit(
  intake: Intake,
  company: { id: string; name: string },
  jobs: DiscoveredJob[],
  tally: IntakeTally,
): Promise<number> {
  let saved = 0;
  for (const job of jobs) {
    const rejection = screen(job, intake.rules);
    if (rejection) {
      tally.rejected[rejection]++;
      noteExample(tally.examples[rejection], job.title);
      continue;
    }
    tally.relevant++;

    const canonical = canonicalUrl(job.url);
    if (intake.known.has(canonical)) {
      tally.rejected.alreadySeen++;
      continue;
    }
    intake.known.add(canonical);

    const named: DiscoveredJob = { ...job, companyName: company.name || job.companyName };
    const lex = scoreLexically(named, intake.scoring);
    try {
      const lead = await prisma.jobLead.create({
        data: {
          profileId: intake.profileId,
          companyId: company.id,
          url: job.url,
          ats: job.ats,
          title: job.title,
          companyName: named.companyName,
          location: job.location ?? null,
          remote: job.remote,
          descriptionText: job.descriptionText,
          // Only the date the source gave; never a guess.
          postedAt: job.postedAt && !Number.isNaN(job.postedAt.getTime()) ? job.postedAt : null,
          score: lex.score,
          scoreReasons: serialiseReasons(lex, null),
          scoredAt: new Date(),
          deepScored: false,
        },
      });
      saved++;
      tally.saved++;
      tally.fresh.push({ id: lead.id, job: named, lexScore: lex.score });
    } catch (err) {
      tally.errors.push({ where: `saving ${job.url}`, error: (err as Error).message });
    }
  }
  return saved;
}
