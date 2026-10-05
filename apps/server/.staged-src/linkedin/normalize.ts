/**
 * Turning what LinkedIn renders into keys we can store and compare.
 *
 * Every identifier on LinkedIn arrives wrapped in tracking parameters and
 * inconsistent casing, and none of it is stable if you keep it verbatim. The
 * same recruiter appears as `/in/jane-doe-123?miniProfileUrn=...` in a search
 * result and `/in/jane-doe-123/` on their own page; the same posting is
 * `/jobs/view/3912...` in one place and `?currentJobId=3912...` in another.
 * Storing either raw guarantees duplicate rows and duplicate messages, which
 * is the one failure mode this feature must not have.
 */

/**
 * Legal and boilerplate suffixes that are noise when deciding whether two
 * spellings name one company.
 *
 * No dotted variants ("inc.", "b.v.") because punctuation is stripped before
 * this runs - an alternative containing a dot could never match.
 */
const LEGAL_SUFFIX =
  /\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|bv|ag|oy|ab|as|pty|pvt|holdings|group|technologies|technology|labs)\b/g;

/**
 * A company name reduced to something two spellings of it agree on.
 *
 * Deliberately lossy. "Mercury Technologies, Inc." and "Mercury" have to land
 * on the same key or the outreach page shows one company twice, and the cost
 * of over-merging two genuinely different companies with the same short name
 * is a mis-grouped card rather than a wrong message: every message carries the
 * full company name it was drafted against, not this key.
 */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    // Combining marks, as an explicit range: the literal characters are
    // invisible in an editor and do not survive being copied around.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The canonical public profile URL, or null if this is not one.
 *
 * Null matters: search results contain links to companies, schools, posts and
 * "see all results" pages, and treating any of those as a person is how a
 * message gets drafted to a school.
 */
export function canonicalProfileUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, 'https://www.linkedin.com');
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/.test(url.hostname)) return null;
  const match = /^\/in\/([^/?#]+)/.exec(url.pathname);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]!).toLowerCase();
  // Slugs are ASCII-ish but not guaranteed; what they are never is empty or a
  // reserved path segment.
  if (!slug || slug === 'unavailable') return null;
  return `https://www.linkedin.com/in/${slug}`;
}

/** The job id out of any of the shapes LinkedIn links a posting by. */
export function jobIdFrom(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, 'https://www.linkedin.com');
  } catch {
    return null;
  }
  const fromPath = /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/.exec(url.pathname);
  if (fromPath) return fromPath[1]!;
  const current = url.searchParams.get('currentJobId');
  if (current && /^\d{6,}$/.test(current)) return current;
  return null;
}

/** The stable posting URL for a job id. */
export const jobUrlFor = (jobId: string): string => `https://www.linkedin.com/jobs/view/${jobId}/`;

/**
 * Whether a headline plausibly places this person at this company.
 *
 * LinkedIn's people search honours a company filter loosely - it will return
 * people who once worked there, people whose headline merely mentions it, and
 * a tail of people with no connection at all. Checking the headline ourselves
 * is the cheap half of the fix; the expensive half (opening every profile) is
 * not worth it for a message a human reads before it goes.
 *
 * "Ex-" and "former" are excluded explicitly, because a headline reading
 * "Ex-Stripe Engineering Manager" contains the company name and is exactly the
 * person not to ask about a Stripe opening.
 */
export function headlineMatchesCompany(headline: string, company: string): boolean {
  const key = companyKey(company);
  if (!key) return false;
  const text = ` ${companyKey(headline)} `;
  if (!text.includes(` ${key} `)) return false;
  // Look at the raw headline for the past-tense markers; companyKey strips the
  // hyphen that "Ex-Stripe" depends on.
  const raw = headline.toLowerCase();
  const escaped = company.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !new RegExp(`\\b(ex|former|formerly|previously|alum|alumni)\\b[^a-z0-9]{0,3}${escaped}`).test(raw);
}
