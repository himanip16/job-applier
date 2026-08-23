/**
 * Recognising an ATS posting URL, and reducing it to the board it lives on.
 *
 * This is the hinge between web search and the board APIs. A search result is
 * just a URL; `https://job-boards.greenhouse.io/mercury/jobs/6118243004` tells
 * us the posting is Greenhouse board "mercury", and that is enough to call
 * boards-api.greenhouse.io and get every open role there with full
 * descriptions - structured, free, and far better than parsing the page we
 * found.
 *
 * So the search never needs to scrape. It needs to recognise.
 */

export interface BoardRef {
  /** Matches a Source id in sources.ts. */
  ats: 'greenhouse' | 'lever' | 'ashby' | 'workable';
  /** The board slug, as those APIs expect it. */
  slug: string;
}

/** The hostnames worth searching, because we can apply on all of them. */
export const ATS_SEARCH_DOMAINS = [
  'job-boards.greenhouse.io',
  'boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
] as const;

/**
 * Slugs that are really route segments. Without this, an embed URL is read as
 * a company called "embed" and we go asking Greenhouse for its jobs.
 */
const RESERVED = new Set(['embed', 'jobs', 'job', 'apply', 'api', 'search', 'j', '']);

/** Identify the board a posting URL belongs to, or null if we cannot apply there. */
export function parseBoardUrl(rawUrl: string): BoardRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeSafely);

  if (host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io') {
    // The embed form carries the board in a query parameter instead of the
    // path: /embed/job_app?for=acme&token=123.
    if (parts[0] === 'embed') {
      const forParam = url.searchParams.get('for');
      return forParam && !RESERVED.has(forParam) ? { ats: 'greenhouse', slug: forParam } : null;
    }
    return usable(parts[0]) ? { ats: 'greenhouse', slug: parts[0]! } : null;
  }

  if (host === 'jobs.lever.co') {
    return usable(parts[0]) ? { ats: 'lever', slug: parts[0]! } : null;
  }

  if (host === 'jobs.ashbyhq.com') {
    return usable(parts[0]) ? { ats: 'ashby', slug: parts[0]! } : null;
  }

  if (host === 'apply.workable.com') {
    return usable(parts[0]) ? { ats: 'workable', slug: parts[0]! } : null;
  }

  return null;
}

const usable = (segment: string | undefined): boolean =>
  Boolean(segment) && !RESERVED.has(segment!.toLowerCase());

function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Same board, written two ways, is still one board. */
export const boardKey = (ref: BoardRef): string => `${ref.ats}:${ref.slug.toLowerCase()}`;

/**
 * A display name for the company, taken from the search result title.
 *
 * The board APIs return the slug, not the name - Greenhouse hands back
 * "mochihealth" for a company that calls itself Mochi Health. Search result
 * titles are written by the ATS and carry the real one in a small number of
 * predictable shapes:
 *
 *   "Job Application for Senior Backend Engineer at Mochi Health"
 *   "Senior Backend Engineer @ Nash"
 *   "Senior Engineer - Careers at Acme"
 *
 * Worth the twenty lines: "mochihealth" in a triage queue reads like a typo.
 */
export function companyNameFromTitle(title: string, slug: string): string {
  const cleaned = title
    .replace(/\s*[|·]\s*(careers?|jobs?|job board|current openings).*$/i, '')
    .replace(/\s*-\s*careers?\s*$/i, '')
    .trim();

  const patterns = [
    /\bjob application for .+? at (.+)$/i,
    /\bcareers? at (.+)$/i,
    /\s@\s*(.+)$/,
    /\bat\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s*$/,
  ];
  for (const re of patterns) {
    const m = cleaned.match(re);
    const found = m?.[1]?.trim().replace(/[.,]$/, '');
    // A "name" longer than this is a sentence fragment that happened to match.
    if (found && found.length >= 2 && found.length <= 60) return found;
  }
  return prettifySlug(slug);
}

/**
 * Last resort when the title gives us nothing.
 *
 * Only separators are trusted. "mochihealth" is left alone rather than guessed
 * at as "Mochi Health": splitting runs of letters into words needs a
 * dictionary, and a wrong split looks worse than a lowercase slug.
 */
export function prettifySlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
