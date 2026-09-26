import { type BoardRef, boardKey, parseBoardUrl } from './boardUrls.js';
import { type SearchHit } from './firecrawl.js';
import { type DiscoveredJob } from './sources/index.js';

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

/**
 * ATS page titles are wrapped in boilerplate that would end up in the queue.
 */
export function cleanHitTitle(title: string): string {
  return title
    .replace(/^job application for\s+/i, '')
    .replace(/\s+at\s+[^|@]+$/i, '')
    .replace(/\s*[@|·]\s*.*$/, '')
    .replace(/\s*-\s*careers?\s*$/i, '')
    .trim();
}

/**
 * One URL, one lead.
 *
 * Search hands back `http://job-boards.greenhouse.io/fal/jobs/4009193009`
 * while the board API returns the same posting over https, often with a
 * tracking parameter and sometimes a trailing slash. Compared raw, those are
 * four different jobs, and the queue fills up with the same posting.
 */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return raw.trim();
  }
}

/** Search hands back http:// for pages that are served over https. */
export function preferHttps(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.toString();
  } catch {
    return raw;
  }
}

/** Leads built from the search result alone, when a board API will not answer. */
export function fallbackJobsFromHits(
  ref: BoardRef,
  matchedUrls: Set<string>,
  hitsByUrl: Map<string, SearchHit>,
  companyName?: string,
): DiscoveredJob[] {
  const out: DiscoveredJob[] = [];
  for (const url of matchedUrls) {
    const hit = hitsByUrl.get(url);
    if (!hit) continue;
    const hitRef = parseBoardUrl(hit.url);
    if (!hitRef || boardKey(hitRef) !== boardKey(ref)) continue;
    out.push({
      // Upgraded, but not canonicalised: this URL is what the browser will
      // actually open, and stripping the query would break a Greenhouse embed
      // link, which carries the board and the job in `?for=` and `?token=`.
      url: preferHttps(hit.url),
      ats: ref.ats,
      title: cleanHitTitle(hit.title) || hit.url,
      companyName: companyName ?? ref.slug,
      remote: /\bremote\b/i.test(`${hit.title} ${hit.description}`),
      // Search descriptions are a couple of sentences, so this lead gets a
      // weaker score than a hydrated one. Better than losing it.
      descriptionText: hit.description,
    });
  }
  return out;
}
