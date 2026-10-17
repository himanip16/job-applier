import { locatedIn, type Country } from '@ja/shared';
import { isSeniorLevel, isStale, requiresMoreThan5YearsExperience } from './jobFilters.js';
import { isJuniorRole, openToIndia, wrongDomain } from './leadCleanup.js';
import type { DiscoveredJob } from './sources/index.js';
import { jobMatchesPlan } from './titleMatch.js';

/**
 * The rules a discovered posting must pass before it may become a lead.
 * Pure: no database, so they can be checked anywhere and tested on their own.
 */

/** Why a posting was turned away, for the run's report. */
export type Rejection = 'tooOld' | 'wrongDomain' | 'tooSenior' | 'tooJunior' | 'otherCountry' | 'offPlan' | 'alreadySeen';

export interface IntakeRules {
  /** Only postings in this country (or remote and open to it). */
  country?: Country;
  /**
   * With no country: only postings someone in India could take - in India,
   * remote from anywhere, or abroad with sponsorship or relocation.
   */
  openToIndia?: boolean;
  /** Only postings whose title matches one of these. Omit to keep every title. */
  roleTitles?: string[];
}

/** The first rule a posting breaks, or null if it may be saved. */
export function screen(job: DiscoveredJob, rules: IntakeRules): Exclude<Rejection, 'alreadySeen'> | null {
  if (isStale(job.postedAt)) return 'tooOld';
  // Sales engineers, recruiters, Workday configurators: not this job, whatever the keywords say.
  if (wrongDomain(job.title)) return 'wrongDomain';
  if (isSeniorLevel(job.title) || requiresMoreThan5YearsExperience(job.descriptionText)) return 'tooSenior';
  // Internships and graduate schemes: years past them.
  if (isJuniorRole(job.title)) return 'tooJunior';
  if (rules.roleTitles && !jobMatchesPlan(job, rules.roleTitles)) return 'offPlan';
  // A board lists every office. You asked for one country.
  if (rules.country && !locatedIn(job.location, job.remote, rules.country)) return 'otherCountry';
  if (!rules.country && rules.openToIndia && !openToIndia(job.location, job.remote, job.descriptionText)) return 'otherCountry';
  return null;
}

const EXAMPLES_PER_RULE = 5;

/** Keep a few distinct titles behind a rejection, for the run's report. */
export function noteExample(examples: string[], title: string): void {
  const t = title.trim();
  if (examples.length >= EXAMPLES_PER_RULE || !t) return;
  if (examples.some((e) => e.toLowerCase() === t.toLowerCase())) return;
  examples.push(t);
}
