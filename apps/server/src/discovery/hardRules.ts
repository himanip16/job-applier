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
    // $100,000 - $150,000 per year
    /\$\s*([0-9,]+(?:\.[0-9]+)?)\s*[-–]\s*\$?\s*([0-9,]+(?:\.[0-9]+)?)\s*(?:per\s+year|annual|annually|year|yr)/i,
    // $100k - $150k
    /\$\s*([0-9,]+(?:\.[0-9]+)?)\s*[-–]\s*\$?\s*([0-9,]+(?:\.[0-9]+)?)\s*k\b/i,
    // $100,000 per year
    /\$\s*([0-9,]+(?:\.[0-9]+)?)\s*(?:per\s+year|annual|annually|year|yr)/i,
    // 100k - 150k
    /([0-9,]+(?:\.[0-9]+)?)\s*[-–]\s*([0-9,]+(?:\.[0-9]+)?)\s*k\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // For ranges, use the upper bound as the potential salary
      const value = match[2] ? match[2] : match[1];
      if (!value) continue;
      // Remove commas and handle 'k' suffix
      let numStr = value.replace(/,/g, '').toLowerCase();
      if (numStr.endsWith('k')) {
        numStr = numStr.slice(0, -1);
        return Number(numStr) * 1000;
      }
      return Number(numStr);
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
 * Parse current CTC from profile.
 * Checks both the currentCTC field and facts.
 */
export function parseCurrentCTC(profile: {
  currentCTC?: string | null;
  facts?: { key: string; value: string }[];
}): number | null {
  // Check facts first
  const currentFact = profile.facts?.find((f) => 
    /current.*salary|current.*ctc|current.*compensation|existing.*salary|existing.*ctc/i.test(f.key)
  );
  const currentSalary = currentFact ? parseSalary(currentFact.value) : null;
  const currentCTC = profile.currentCTC ? parseSalary(profile.currentCTC) : null;

  return currentSalary ?? currentCTC;
}

/**
 * Check if job salary matches candidate's expectations and current CTC.
 */
export function salaryVerdict(
  expectations: { min: number | null; max: number | null },
  currentCTC: number | null,
  job: ScorableJob,
): HardRuleVerdict | null {
  if (!expectations.min && !expectations.max && !currentCTC) return null;

  const text = `${job.title}\n${job.descriptionText ?? ''}`;
  const jobSalary = parseSalary(text);
  
  if (!jobSalary) return null; // Can't determine job salary

  // First check against current CTC - this is a hard requirement
  if (currentCTC && jobSalary < currentCTC) {
    return {
      dealbreaker: `Job salary (~$${(jobSalary / 1000).toFixed(0)}k) is below your current CTC ($${(currentCTC / 1000).toFixed(0)}k).`,
      against: `Salary offered is lower than your current compensation.`,
    };
  }

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

  // If we only have current CTC and job is above it
  if (currentCTC && jobSalary >= currentCTC) {
    const premium = ((jobSalary - currentCTC) / currentCTC * 100).toFixed(0);
    return { for: `Job salary (~$${(jobSalary / 1000).toFixed(0)}k) is ${premium}% above your current CTC ($${(currentCTC / 1000).toFixed(0)}k).` };
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

// ---------------------------------------------------------------- domain ---

/**
 * Titles that are simply somebody else's job.
 *
 * A backend engineer's queue should never contain a recruiter, a marketer or
 * an account executive, and it kept containing them: a keyword scorer sees
 * "Talent Acquisition Partner - Engineering" sharing the word "engineering"
 * with the resume, and a model asked whether it fits will hedge rather than
 * say no.
 *
 * Matched on the title only. A description mentions sales, marketing and
 * recruiting in passing on almost every posting - "you will partner with
 * sales" is on half the engineering jobs ever written - so reading the body
 * for these words would throw away the good ones.
 */
const OFF_DOMAIN = [
  ['recruiting', /\b(recruit(er|ing|ment)?|talent acquisition|sourcer|people (ops|operations|partner)|hr\b|human resources|hris)\b/i],
  ['sales', /\b(sales|account (executive|manager|director)|business development|bdr\b|sdr\b|revenue (operations|ops)|quota|pre[- ]?sales)\b/i],
  ['marketing', /\b(marketer|marketing|brand|content strateg|seo\b|demand gen|growth marketing|communications|social media|copywriter|public relations)\b/i],
  ['customer support', /\b(customer (support|success|service|experience)|support (agent|specialist|advocate)|help ?desk|technical support)\b/i],
  ['finance and legal', /\b(accountant|accounting|bookkeep|controller|auditor|counsel|paralegal|attorney|paraleg|compliance (officer|manager)|underwrit|actuar|tax\b)\b/i],
  ['design', /\b(product|graphic|visual|brand|ux|ui) designer\b|\b(ux|ui) (researcher|writer)\b|\billustrator\b|\bcopy ?editor\b/i],
  ['product management', /\bproduct (manager|owner|lead|management)\b|\bhead of product\b/i],
  ['partnerships', /\bpartnerships?\b|\bbiz ?dev\b|\balliances\b/i],
  ['program management', /\b(program|project|delivery) manager\b|\bprogram management\b|\bscrum master\b|\bchief of staff\b/i],
  ['risk and operations', /\b(underwrit|actuar|risk (manager|strategist|analyst)|fraud (analyst|investigator)|operations (lead|manager|specialist|analyst))\b/i],
  ['operations', /\b(office manager|executive assistant|administrative assistant|facilities|procurement|logistics coordinator|warehouse|events? (and|&) experiences?|events specialist)\b/i],
] as const;

/**
 * Words that put a title back in scope even though an off-domain word matched.
 *
 * "Sales Engineering Manager" is still sales; "Software Engineer, Marketing
 * Platform" is not marketing. The difference is whether the engineering word
 * is the noun or the qualifier, which in practice means: does the title lead
 * with a job this person does.
 */
const DISCIPLINE =
  '(?:software|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|platform|infrastructure|systems?|data|machine learning|ml|ai|devops|site reliability|security|mobile|android|ios|cloud|embedded|qa|test)';
const RANK = '(?:senior|staff|principal|lead|junior|associate|sr\\.?|jr\\.?|mid|ii+|[0-9])';
const IN_DOMAIN_HEAD = new RegExp(
  // "Senior Backend Engineer, Growth" - the discipline leads, the team follows.
  `^(?:${RANK}\\s+)?${DISCIPLINE}\\b` +
    // "Head of Data Engineering", "Director of Infrastructure" - the same job,
    // one rung up, and still this person's profession.
    `|^(?:head of|director of|vp of|vice president,? of)\\s+${DISCIPLINE}\\b` +
    // A bare engineering title with no qualifier at all.
    `|^(?:${RANK}\\s+)?(?:engineer|developer|architect|programmer)\\b`,
  'i',
);

/** Is this title a job in another profession entirely? */
export function offDomainVerdict(title: string): HardRuleVerdict | null {
  const clean = title.trim();
  // A title that starts by naming an engineering discipline is in scope, even
  // when the team it serves is a sales or marketing one.
  if (IN_DOMAIN_HEAD.test(clean)) return null;

  for (const [domain, pattern] of OFF_DOMAIN) {
    if (!pattern.test(clean)) continue;
    return {
      dealbreaker: `Not your profession - this is a ${domain} role.`,
      against: `"${clean}" is a ${domain} job, not an engineering one.`,
    };
  }
  return null;
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
  args: { candidateYears: number | null; needsSponsorship: boolean; salaryExpectations: { min: number | null; max: number | null }; currentCTC: number | null; job: ScorableJob },
): FitAssessment {
  const text = `${args.job.title}\n${args.job.descriptionText ?? ''}`;
  const verdicts = [
    offDomainVerdict(args.job.title),
    experienceVerdict(args.candidateYears, text),
    sponsorshipVerdict(args.needsSponsorship, args.job),
    salaryVerdict(args.salaryExpectations, args.currentCTC, args.job),
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
export function candidateConstraints(profile: {
  country?: string | null;
  countryCode?: string | null;
  citizenship?: string | null;
  currentCTC?: string | null;
  expectedCTC?: string | null;
  summary?: string | null;
  resumeText?: string | null;
  facts?: { key: string; value: string }[];
}): { candidateYears: number | null; needsSponsorship: boolean; salaryExpectations: { min: number | null; max: number | null }; currentCTC: number | null } {
  const stated = profile.facts?.find((f) => /experience.*years|years.*experience|yoe/i.test(f.key));
  // A stated fact is usually just the number - "4.5", not "4.5 years" - so it
  // is read as one before falling back to the prose patterns.
  const statedYears = stated ? (bareNumber(stated.value) ?? parseYears(stated.value)) : null;
  const candidateYears =
    statedYears ??
    parseYears(normalizeLabel(profile.summary ?? '')) ??
    parseYears(normalizeLabel((profile.resumeText ?? '').slice(0, 1500)));

  // Anyone not a US citizen needs sponsoring for a US role. Citizenship is the
  // primary factor - location matters less. Stated as "not US citizen" rather
  // than "is India" so it stays true if they move.
  const citizenship = normalizeLabel(profile.citizenship ?? '');
  const countryCode = (profile.countryCode ?? '').toUpperCase();
  const country = normalizeLabel(profile.country ?? '');
  
  // Check if citizenship is US
  const isUSCitizen = /^(united states|usa|us|american)$/i.test(citizenship) || 
                      citizenship.toUpperCase() === 'US' ||
                      citizenship === 'United States';
  
  // If citizenship is not set, fall back to location check
  const inUS = countryCode === 'US' || /^(united states|usa|us)$/.test(country);
  
  const salaryExpectations = parseSalaryExpectation(profile);
  const currentCTC = parseCurrentCTC(profile);
  
  return { candidateYears, needsSponsorship: !isUSCitizen, salaryExpectations, currentCTC };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function bareNumber(value: string): number | null {
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 && n < 60 ? n : null;
}
