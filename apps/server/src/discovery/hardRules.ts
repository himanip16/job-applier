import { normalizeLabel } from '@ja/shared';
import type { FitAssessment, ScorableJob } from './scoring.js';

/**
 * The two answers that are "no" regardless of how well the job reads.
 *
 * A model asked to judge fit will talk itself round on both of these. It will
 * call seven years "a stretch but the domain overlap is strong" for a
 * four-and-a-half-year candidate, and it will read a US posting that says
 * nothing at all about visas as though silence were an open door. Neither is
 * a judgement call, so neither is left to judgement: they are rules, they run
 * on every scoring path, and they say plainly which rule fired.
 */

/** Half a year either way is noise, not a gap. */
const TOLERANCE_YEARS = 0.5;

/** Past this, the posting is asking for someone else. */
const HARD_SHORTFALL_YEARS = 1;

export interface HardRuleVerdict {
  /** Set when the rule is fatal; blendScores caps a dealbreaker at 15. */
  dealbreaker?: string;
  /** Added to the model's reasons, whether fatal or not. */
  against?: string;
  for?: string;
}

// ------------------------------------------------------------------ salary ---

/**
 * Parse salary/compensation from text.
 * Returns the annual salary in USD if found, null otherwise.
 */
export function parseSalary(text: string): number | null {
  const patterns = [
    // Range: $100k - $150k or $100,000 - $150,000
    /\$\s*([0-9,]+)\s*k?\s*[-–]\s*\$?\s*([0-9,]+)\s*k?/i,
    // Single: $150,000 or $150k
    /\$\s*([0-9,]+)\s*(?:k\b|per\s+year|annual|yr)?/i,
    // Single: 150k
    /\b([0-9]+)\s*k\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const rawVal = match[2] ?? match[1];
      if (!rawVal) continue;
      let val = rawVal.replace(/,/g, '').toLowerCase();
      let num = Number(val);
      if (val.endsWith('k') || num < 1000) num *= 1000; // Handle k suffix or values like 150
      if (num >= 20000 && num <= 1000000) return num; // Reasonable annual salary range
    }
  }
  return null;
}

/**
 * Parse salary expectation from profile.
 * Checks both the expectedCTC field and facts.
 */
export function parseSalaryExpectation(profile: {
  expectedCTC?: string | null;
  facts?: { key: string; value: string }[];
}): { min: number | null; max: number | null } {
  // Check facts first for min/max
  const minFact = profile.facts?.find((f) => 
    /compensation.*expectation.*min|salary.*expectation.*min|min.*salary|min.*compensation/i.test(f.key)
  );
  const maxFact = profile.facts?.find((f) => 
    /compensation.*expectation.*max|salary.*expectation.*max|max.*salary|max.*compensation/i.test(f.key)
  );
  const generalFact = profile.facts?.find((f) => 
    /compensation.*expectation|salary.*expectation|expected.*salary|expected.*ctc/i.test(f.key)
  );

  const minSalary = minFact ? parseSalary(minFact.value) : null;
  const maxSalary = maxFact ? parseSalary(maxFact.value) : null;
  const generalSalary = generalFact ? parseSalary(generalFact.value) : null;
  const expectedCTC = profile.expectedCTC ? parseSalary(profile.expectedCTC) : null;

  // Use the most specific information available
  const min = minSalary ?? generalSalary ?? expectedCTC;
  const max = maxSalary ?? generalSalary ?? expectedCTC;

  return { min, max };
}

/**
 * Check if job salary matches candidate's expectations.
 */
export function salaryVerdict(
  expectations: { min: number | null; max: number | null },
  job: ScorableJob,
): HardRuleVerdict | null {
  if (!expectations.min && !expectations.max) return null;

  const text = `${job.title}\n${job.descriptionText ?? ''}`;
  const jobSalary = parseSalary(text);
  
  if (!jobSalary) return null; // Can't determine job salary

  // If we have both min and max expectations
  if (expectations.min && expectations.max) {
    if (jobSalary < expectations.min) {
      return {
        dealbreaker: `Job salary (~$${(jobSalary / 1000).toFixed(0)}k) is below your minimum expectation ($${(expectations.min / 1000).toFixed(0)}k).`,
        against: `Salary offered is lower than your minimum requirement.`,
      };
    }
    if (jobSalary > expectations.max) {
      return {
        against: `Job salary (~$${(jobSalary / 1000).toFixed(0)}k) is above your maximum expectation ($${(expectations.max / 1000).toFixed(0)}k).`,
      };
    }
    return { for: `Job salary (~$${(jobSalary / 1000).toFixed(0)}k) matches your expectations.` };
  }

  // If we only have minimum expectation
  if (expectations.min && jobSalary < expectations.min) {
    return {
      dealbreaker: `Job salary (~$${(jobSalary / 1000).toFixed(0)}k) is below your minimum expectation ($${(expectations.min / 1000).toFixed(0)}k).`,
      against: `Salary offered is lower than your minimum requirement.`,
    };
  }

  // If we only have maximum expectation and job exceeds it significantly
  if (expectations.max && jobSalary > expectations.max * 1.2) {
    return {
      against: `Job salary (~$${(jobSalary / 1000).toFixed(0)}k) is significantly above your maximum expectation ($${(expectations.max / 1000).toFixed(0)}k).`,
    };
  }

  return { for: `Job salary (~$${(jobSalary / 1000).toFixed(0)}k) aligns with your expectations.` };
}

/**
 * Years, with the decimal kept.
 *
 * The old pattern captured only the digits before the point, so a candidate
 * with 4.5 years was read as 4 and every posting asking for 5 became a
 * shortfall it did not have.
 */
export function parseYears(text: string): number | null {
  const patterns = [
    /(\d{1,2}(?:\.\d+)?)\s*\+?\s*years?\s*(?:of\s+)?(?:professional|relevant|total|industry|hands[- ]on)?\s*experience\b/i,
    /\bexperience\b[^0-9]{0,60}(\d{1,2}(?:\.\d+)?)\s*\+?\s*years?\b/i,
    /(\d{1,2}(?:\.\d+)?)\s*\+?\s*years?\b/i,
  ];
  for (const pattern of patterns) {
    const n = Number(text.match(pattern)?.[1]);
    if (Number.isFinite(n) && n > 0 && n < 60) return n;
  }
  return null;
}

/**
 * The largest number of years the posting asks for.
 *
 * Largest, not first: a posting that says "3+ years of Python, 7+ years of
 * distributed systems" is asking for seven, and reading the first number
 * would let the hardest requirement in the list go unnoticed.
 */
export function parseRequiredYears(jobText: string): number | null {
  const text = jobText.slice(0, 8000);
  let most: number | null = null;
  const pattern = /(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:-\s*\d{1,2}\s*)?years?\b/gi;
  for (const match of text.matchAll(pattern)) {
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n <= 0 || n > 30) continue;
    // "5 years ago", "the last 3 years" and "founded 12 years ago" are prose,
    // not requirements.
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
    if (/^\s*ago\b/i.test(after)) continue;
    if (most === null || n > most) most = n;
  }
  return most;
}

/** Does this posting want more experience than the candidate has? */
export function experienceVerdict(candidateYears: number | null, jobText: string): HardRuleVerdict | null {
  if (candidateYears === null) return null;
  const required = parseRequiredYears(jobText);
  if (required === null) return null;

  const shortfall = required - candidateYears;
  if (shortfall <= TOLERANCE_YEARS) {
    return shortfall <= -2
      ? { for: `Comfortably past the ${required}-year bar with ${candidateYears} years.` }
      : null;
  }

  const gap = `the posting asks for ${required}+ years and you have ${candidateYears}`;
  if (shortfall > HARD_SHORTFALL_YEARS) {
    return {
      dealbreaker: `Wants ${required}+ years of experience; you have ${candidateYears}.`,
      against: `Too senior by ${round1(shortfall)} years — ${gap}.`,
    };
  }
  return { against: `Slightly under the experience bar — ${gap}.` };
}

// ------------------------------------------------------------------ visas ---

const US_LOCATION =
  /\b(united states|u\.?s\.?a?\b|usa|new york|san francisco|bay area|seattle|austin|boston|chicago|denver|atlanta|los angeles|washington,? d\.?c|remote[ -]*(?:us|usa|united states)|us[ -]*remote)\b/i;

/** Two-letter state codes, only where a city or comma makes them a location. */
const US_STATE = /,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/i;

const WILL_SPONSOR =
  /\b(visa sponsorship (?:is )?(?:available|offered|provided)|we (?:will |can |do )?sponsor|sponsorship (?:is )?(?:available|offered|provided)|will sponsor|able to sponsor|h-?1b (?:sponsorship|visa|transfer)s? (?:available|offered|considered|supported)|open to sponsoring|we sponsor visas)\b/i;

const WELCOMES_INDIA = /\b(hiring in india|based in india|candidates? (?:from|in|based in) india|india[- ]based|open to (?:candidates in )?india)\b/i;

const WILL_NOT_SPONSOR =
  /\b(no visa sponsorship|not (?:be )?(?:able|willing) to sponsor|unable to sponsor|cannot sponsor|do(?:es)? not (?:offer|provide) sponsorship|without (?:the need for )?sponsorship|sponsorship is not (?:available|offered|provided)|must (?:be|already be) (?:legally )?authori[sz]ed to work in the (?:us|united states)(?! .{0,40}sponsor))\b/i;

/**
 * Silence is a no.
 *
 * This is the candidate's own rule, and it is the right way round: a US
 * posting that does not mention sponsorship overwhelmingly does not offer it,
 * and the cost of the two mistakes is not symmetric. Wrongly skipping one
 * costs an opening; wrongly applying to fifty costs weeks, and every one of
 * them ends the same way.
 */
export function sponsorshipVerdict(
  needsSponsorship: boolean,
  job: ScorableJob,
): HardRuleVerdict | null {
  if (!needsSponsorship) return null;

  const where = `${job.location ?? ''} ${job.title}`;
  const body = (job.descriptionText ?? '').slice(0, 12000);
  const inUS = US_LOCATION.test(where) || US_STATE.test(where) || US_LOCATION.test(body.slice(0, 600));
  if (!inUS) return null;

  if (WELCOMES_INDIA.test(body) || WELCOMES_INDIA.test(where)) return null;

  if (WILL_NOT_SPONSOR.test(body)) {
    return {
      dealbreaker: 'US role that says outright it will not sponsor a visa.',
      against: 'The posting rules out sponsorship in so many words.',
    };
  }
  if (WILL_SPONSOR.test(body)) {
    return { for: 'US role that says it sponsors visas.' };
  }
  return {
    dealbreaker: 'US role that never mentions visa sponsorship.',
    against:
      'Nothing in the posting says it sponsors, and a US role that stays silent on it almost never does.',
  };
}

// ----------------------------------------------------------------- apply ---

/**
 * Fold both rules into the model's assessment.
 *
 * Returned as a dealbreaker rather than as a subtracted score, because a
 * subtraction is a negotiation: it turned a model's 90 into a 33, which still
 * outranks plenty of jobs that are genuinely open to you. A dealbreaker is
 * capped at 15 by blendScores, which is what "no" looks like in a ranking.
 */
export function applyHardRules(
  fit: FitAssessment,
  args: { candidateYears: number | null; needsSponsorship: boolean; salaryExpectations: { min: number | null; max: number | null }; job: ScorableJob },
): FitAssessment {
  const text = `${args.job.title}\n${args.job.descriptionText ?? ''}`;
  const verdicts = [
    experienceVerdict(args.candidateYears, text),
    sponsorshipVerdict(args.needsSponsorship, args.job),
    salaryVerdict(args.salaryExpectations, args.job),
  ].filter(Boolean) as HardRuleVerdict[];
  if (!verdicts.length) return fit;

  const blocking = verdicts.filter((v) => v.dealbreaker);
  return {
    ...fit,
    // The model's own blocker wins if it found one; it read the whole posting.
    dealbreaker: fit.dealbreaker || blocking.map((v) => v.dealbreaker).join(' '),
    againstIt: [
      ...new Set([...(fit.againstIt ?? []), ...verdicts.map((v) => v.against).filter(Boolean)]),
    ] as string[],
    forIt: [...new Set([...(fit.forIt ?? []), ...verdicts.map((v) => v.for).filter(Boolean)])] as string[],
    verdict: blocking.length ? 'MISMATCH' : fit.verdict,
  };
}

/**
 * What the candidate has and where they are, read once per batch.
 *
 * Years come from a stated fact when there is one, because a resume regex
 * reads the first "3 years" it finds in a bullet about a project.
 */
export interface CandidateConstraints {
  candidateYears: number | null;
  needsSponsorship: boolean;
  salaryExpectations: { min: number | null; max: number | null };
}

/** Extract candidate constraints once per profile batch. */
export function extractCandidateConstraints(profile: {
  candidateYears?: number | null;
  needsSponsorship?: boolean;
  expectedCTC?: string | null;
  facts?: { key: string; value: string }[];
}): CandidateConstraints {
  const yearsFact = profile.facts?.find((f) => /years.*experience|total.*experience/i.test(f.key));
  const candidateYears = profile.candidateYears ?? (yearsFact ? parseYears(yearsFact.value) : null);
  const needsSponsorship = profile.needsSponsorship ?? false;
  const salaryExpectations = parseSalaryExpectation(profile);

  return { candidateYears, needsSponsorship, salaryExpectations };
}

/**
 * Extract country code from a location string.
 * Simple heuristic to detect country names or codes.
 */
function extractCountry(location: string): string | null {
  const loc = location.toLowerCase();
  
  // Common country names
  const countries: Record<string, string> = {
    'united states': 'US',
    'usa': 'US',
    'us': 'US',
    'united kingdom': 'GB',
    'uk': 'GB',
    'canada': 'CA',
    'germany': 'DE',
    'france': 'FR',
    'india': 'IN',
    'australia': 'AU',
    'netherlands': 'NL',
    'singapore': 'SG',
    'japan': 'JP',
    'switzerland': 'CH',
    'ireland': 'IE',
    'spain': 'ES',
    'italy': 'IT',
    'sweden': 'SE',
    'denmark': 'DK',
    'norway': 'NO',
    'finland': 'FI',
    'belgium': 'BE',
    'austria': 'AT',
    'poland': 'PL',
    'czech': 'CZ',
    'brazil': 'BR',
    'mexico': 'MX',
    'argentina': 'AR',
    'colombia': 'CO',
    'chile': 'CL',
    'peru': 'PE',
    'south africa': 'ZA',
    'new zealand': 'NZ',
    'israel': 'IL',
    'uae': 'AE',
    'saudi arabia': 'SA',
    'turkey': 'TR',
    'russia': 'RU',
    'china': 'CN',
    'south korea': 'KR',
    'taiwan': 'TW',
    'hong kong': 'HK',
    'thailand': 'TH',
    'vietnam': 'VN',
    'indonesia': 'ID',
    'malaysia': 'MY',
    'philippines': 'PH',
    'pakistan': 'PK',
    'bangladesh': 'BD',
    'nigeria': 'NG',
    'egypt': 'EG',
    'kenya': 'KE',
    'morocco': 'MA',
  };
  
  for (const [name, code] of Object.entries(countries)) {
    if (loc.includes(name)) {
      return code;
    }
  }
  
  // Check for 2-letter country codes at end of string
  const codeMatch = loc.match(/\b([A-Z]{2})\b$/i);
  if (codeMatch && codeMatch[1]) {
    return codeMatch[1].toUpperCase();
  }
  
  return null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
