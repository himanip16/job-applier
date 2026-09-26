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

/**
 * Check if a job description requires more than 5 years of experience.
 */
export function requiresMoreThan5YearsExperience(description: string | null | undefined): boolean {
  if (!description) return false;
  const descLower = description.toLowerCase();
  
  // Match patterns like "5+ years", "5+ years experience", "6 years", "10+ years", etc.
  const experiencePatterns = [
    /(\d+)\+?\s*years?\s*(of\s*)?(experience|work)/i,
    /(\d+)\s*years?\s*\+\s*(of\s*)?(experience|work)/i,
  ];
  
  for (const pattern of experiencePatterns) {
    const match = descLower.match(pattern);
    if (match && match[1]) {
      const years = parseInt(match[1], 10);
      if (years > 5) return true;
    }
  }
  
  return false;
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
