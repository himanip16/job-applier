import { normalizeLabel, tokenize } from '@ja/shared';

/**
 * Matching posting titles against the role titles a search planned for.
 * Pure: no database or model calls, so screening can use it anywhere.
 */

/**
 * Does a posting we found incidentally look like something this candidate
 * asked for?
 *
 * Hydrating one board returns every opening at that company, which is a gift
 * for coverage and a disaster for a triage queue: search for a backend role at
 * a 2,000-person company and you get their recruiters, their warehouse staff
 * and their VP of Sales. The postings that matched the search are always kept;
 * their siblings have to look like one of the planned role titles.
 */
export function titleMatchesPlan(title: string, roleTitles: string[]): boolean {
  if (!roleTitles.length) return false;
  const normalisedTitle = normalizeTitle(title);
  const titleTokens = new Set(tokenize(normalisedTitle));

  return roleTitles.some((role) => {
    const normalisedRole = normalizeTitle(role);
    const roleTokens = tokenize(normalisedRole);
    const distinctive = roleTokens.filter((t) => !GENERIC_TITLE_TOKENS.has(t));
    const kind = roleTokens.filter((t) => GENERIC_TITLE_TOKENS.has(t));

    // Every token was generic ("Software Engineer"), so token matching would
    // wave through the entire company. Fall back to the phrase itself.
    if (!distinctive.length) {
      const roleKind = withoutLevel(normalisedRole);
      return !!roleKind && withoutLevel(normalisedTitle).includes(roleKind);
    }

    // The distinctive words all have to be there...
    if (!distinctive.every((t) => titleTokens.has(t))) return false;

    // ...and so does the kind of job, when the role title said what kind.
    //
    // Without this, planning for "Staff Software Engineer, Payments" matches
    // Mercury's "Counsel, Product & Regulatory - Payments & AML" on the single
    // word "payments" - a lawyer's job, offered to an engineer. Checked
    // against that company's real board: the domain word is shared by roles
    // across the whole org, and the role word is what separates them.
    if (!kind.length) return true;
    return kind.some((t) => titleTokens.has(t));
  });
}

/**
 * Companies name the same job differently: Amazon posts "SDE-2", Salesforce
 * "SMTS", everyone else "Senior Software Engineer". Plan titles and posting
 * titles are both rewritten into one vocabulary before they are compared, or
 * a plan for "Backend Engineer" never sees a "Backend Developer". Applied in
 * order, to text already through normalizeLabel.
 */
const TITLE_VOCABULARY: [RegExp, string][] = [
  [/\b(back[ -]end|server[ -]side)\b/g, 'backend'],
  [/\bfront[ -]end\b/g, 'frontend'],
  [/\bfull[ -]stack\b/g, 'fullstack'],
  [/\b(smts|senior member of technical staff)\b/g, 'senior software engineer'],
  [/\b(mts|member of technical staff)\b/g, 'software engineer'],
  [/\b(software development engineer|sde)(?:[- ]?(?:iii|ii|i|[1-3]))?\b/g, 'software engineer'],
  [/\bdevelopers?\b/g, 'engineer'],
];

export function normalizeTitle(title: string): string {
  let s = normalizeLabel(title);
  for (const [pattern, replacement] of TITLE_VOCABULARY) s = s.replace(pattern, replacement);
  return s.replace(/\s+/g, ' ').trim();
}

export const withoutLevel = (title: string) => title
  .replace(/\b(senior|junior|staff|principal|lead|associate|mid|level|i|ii|iii|iv|[1-5])\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Generic software titles can describe a speciality in the actual job text. */
export function jobMatchesPlan(job: { title: string; descriptionText?: string | null }, roles: string[]): boolean {
  if (titleMatchesPlan(job.title, roles)) return true;
  // A sales role mentioning backend teams, or an explicitly frontend title,
  // must not pass just because the description contains a matching keyword.
  if (withoutLevel(normalizeTitle(job.title)) !== 'software engineer') return false;
  const description = normalizeTitle((job.descriptionText ?? '').slice(0, 12000));
  return roles.some((role) => {
    const normalized = normalizeTitle(role);
    if (!/\b(?:software|backend|frontend|fullstack|platform) engineer\b/.test(normalized)) return false;
    return titleMatchesPlan(`software engineer ${description}`, [normalized]);
  });
}

/**
 * Words that appear in most titles of a given kind, and so separate nothing
 * on their own - but do say what kind of job it is.
 */
const GENERIC_TITLE_TOKENS = new Set([
  'engineer', 'engineering', 'software', 'developer', 'senior', 'staff', 'lead',
  'principal', 'junior', 'mid', 'level', 'ii', 'iii', 'iv',
]);
