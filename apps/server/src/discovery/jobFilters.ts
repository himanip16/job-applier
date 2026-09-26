/**
 * Senior-level job title patterns to filter out.
 */
export const SENIORITY_PATTERNS = [
  'staff',
  'principal',
  'director',
  'vp',
  'head of',
  'chief',
  'cto',
  'manager',
];

/**
 * Check if a job title indicates a senior-level position.
 */
export function isSeniorLevel(title: string): boolean {
  const titleLower = title.toLowerCase();
  return SENIORITY_PATTERNS.some(pattern => titleLower.includes(pattern));
}

/** What a posting says about the experience it wants. */
export interface ExperienceAsk {
  /** The fewest years it will accept, e.g. 3 for "3-5 years" or "3+ years". */
  min: number;
  /** The top of a stated range, when there is one. */
  max?: number;
  /** The words it came from, verbatim, so the number can be checked. */
  quote: string;
}

// "5+ years", "3-5 years", "3 to 5 yrs", with the experience word nearby.
const YEARS = String.raw`(\d{1,2}(?:\.\d)?)\s*(?:\+|plus)?\s*(?:(?:-|–|—|to)\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*)?(?:years?|yrs?)`;
const EXPERIENCE_ASKS = [
  // "5+ years of (professional / hands-on / relevant ...) experience", "3-5 yrs exp"
  // No other number in between: in "3+ years of Python and 7+ years of experience" the 7 is the ask.
  new RegExp(`${YEARS}(?:\\s+of)?[^.\\n\\d]{0,40}?\\b(?:experience|exp)\\b`, 'gi'),
  // "experience: 5+ years", "minimum experience of 4 years", "experience required - 3 to 5 years"
  new RegExp(`\\b(?:experience|exp)\\b[^.\\n\\d]{0,30}${YEARS}`, 'gi'),
  // "minimum (of) 4 years", "at least 6 years"
  new RegExp(`\\b(?:minimum|min\\.?|at least)\\s+(?:of\\s+)?${YEARS}`, 'gi'),
];

/**
 * The experience a posting asks for, read only from what it says.
 *
 * A number counts only when it is tied to "experience" (or a "minimum"/"at
 * least"): "founded 20 years ago" and "3 years of runway" are not
 * requirements. When a posting names several - "3+ years of Python, 7+ years
 * of distributed systems" - the strictest is the one that decides, so that is
 * the one returned. Nothing stated, nothing returned.
 */
export function requiredExperience(description: string | null | undefined): ExperienceAsk | null {
  const text = (description ?? '').slice(0, 12000);
  let strictest: ExperienceAsk | null = null;
  for (const pattern of EXPERIENCE_ASKS) {
    for (const m of text.matchAll(pattern)) {
      const min = Number(m[1]);
      const max = m[2] !== undefined ? Number(m[2]) : undefined;
      if (!Number.isFinite(min) || min <= 0 || min > 25 || (max !== undefined && (max < min || max > 30))) continue;
      if (!strictest || min > strictest.min) strictest = { min, max, quote: m[0].replace(/\s+/g, ' ').trim() };
    }
  }
  return strictest;
}

/** Whether a posting asks for more than five years - the seniority line this search draws. */
export function requiresMoreThan5YearsExperience(description: string | null | undefined): boolean {
  return (requiredExperience(description)?.min ?? 0) > 5;
}

/** Postings older than this are almost always filled or forgotten. */
export const MAX_POSTING_AGE_DAYS = 90;

/**
 * Whether a posting is too old to be worth applying to.
 *
 * An undated posting is kept: most careers-page crawls have no date, and
 * dropping a live opening costs more than showing a stale one. Some boards
 * send an "updated" date rather than a posted one, which only ever makes a
 * posting look younger, so this errs the same way.
 */
export function isStale(postedAt: Date | null | undefined, now = new Date()): boolean {
  if (!postedAt || Number.isNaN(postedAt.getTime())) return false;
  return now.getTime() - postedAt.getTime() > MAX_POSTING_AGE_DAYS * 24 * 60 * 60 * 1000;
}
