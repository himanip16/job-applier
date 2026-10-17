/**
 * Senior-level job title words to filter out, matched as whole words.
 *
 * "LMTS" and "PMTS" are the lead and principal rungs of Member of Technical
 * Staff; "SMTS" is senior, which this search keeps.
 */
export const SENIORITY_PATTERNS = [
  'staff',
  'principal',
  'director',
  'vp',
  'head of',
  'chief',
  'cto',
  'lmts',
  'pmts',
  // The same rungs in the languages some boards post in. Matched with accents
  // stripped, so "vicepresidente" also covers the accented spelling.
  'directora', 'directeur', 'directrice', 'diretor', 'diretora', 'direktor', 'direktorin',
  'direttore', 'vicepresidente', 'jefe', 'jefa', 'ingeniero principal', 'ingenieur principal',
];

const SENIOR_WORDS = new RegExp(`\\b(${SENIORITY_PATTERNS.join('|')})\\b`);

/**
 * Level codes some companies put in the title: Meta's E6 and up, and L7 and
 * up, which is past senior at both Google and Amazon. L6 is left alone: it is
 * staff at Google but senior at Amazon, and senior is kept. "L7" in a
 * networking title is the protocol layer, not a level.
 */
const LEVEL_CODE = /\b(?:e(?:[6-9]|1\d)|l(?:[7-9]|1\d))\b(?!\s*(?:load|proxy|proxies|network|networking|routing|firewall|traffic|lb|gateway|switch))/;

/**
 * "Manager" in other languages. Like manager, counted only in the role part:
 * "Teamleiter" and "Gerente de Ingeniería" lead a team, "Software Engineer -
 * Gerente project" does not say so.
 */
const MANAGER_WORDS = /\bmanager\b|\bgerente\b|(?:\b|team|abteilungs|bereichs|gruppen)leiter(?:in)?\b|\bresponsable d/;

/**
 * Where the role ends and the team begins: "Engineering Manager - Payments",
 * "Software Engineer, Package Manager", "Engineer (Build Manager)". A bare
 * hyphen is not a break - "Full-Stack Engineering Manager" is one role.
 */
const ROLE_PART_END = /\s-\s|[,(–—]/;

/**
 * Check if a job title indicates a senior-level position.
 *
 * Whole words only: a substring test dropped "Staffing Engineer" for "staff"
 * and "Connectors Engineer" for "cto". "Member of Technical Staff"
 * is a title, not the staff level, so it is taken out first - except its lead
 * rung, spelled out. "Manager" only counts in the role itself, so "Software
 * Engineer - Package Manager" is kept and "Engineering Manager - Payments" is
 * not.
 */
export function isSeniorLevel(title: string): boolean {
  const titleLower = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\blead member of technical staff\b/g, 'lmts')
    .replace(/\btechnical staff\b/g, ' ');
  if (SENIOR_WORDS.test(titleLower) || LEVEL_CODE.test(titleLower)) return true;
  const role = titleLower.split(ROLE_PART_END)[0] ?? titleLower;
  return MANAGER_WORDS.test(role);
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

// "5+ years", "3-5 years", "3 to 5 yrs.", with the experience word nearby.
const YEARS = String.raw`(\d{1,2}(?:\.\d)?)\s*(?:\+|plus)?\s*(?:(?:-|–|—|to)\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*)?(?:years?|yrs?\.?)`;
const EXPERIENCE_ASKS = [
  // "5+ years of (professional / hands-on / relevant ...) experience", "3-5 yrs exp"
  // No other number in between: in "3+ years of Python and 7+ years of experience" the 7 is the ask.
  new RegExp(`${YEARS}(?:\\s+of)?[^.\\n\\d]{0,40}?\\b(?:experience|exp)\\b`, 'gi'),
  // "experience: 5+ years", "minimum experience of 4 years", "experience required - 3 to 5 years",
  // and a heading over its bullet: "Experience:\n- 7+ years". One line break only, so it can't reach into the next section.
  new RegExp(`\\b(?:experience|exp)\\b[^.\\n\\d]{0,30}(?:\\n\\s*[-•*]?\\s*)?${YEARS}`, 'gi'),
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
