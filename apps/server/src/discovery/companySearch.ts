import { readFileSync } from 'node:fs';
import { prisma } from '../lib/db.js';
import { ATS_SEARCH_DOMAINS, parseBoardUrl } from './boardUrls.js';
import { firecrawlSearch, isFirecrawlConfigured } from './firecrawl.js';
import { getJson, getText } from './sources/http.js';
import type { TargetCompany } from './topCompanies.js';

/**
 * Finding one company's careers source from nothing but its name.
 *
 * "Search top companies" reads a fixed list. This is the other way in: you
 * type "Swiggy" and it works out where Swiggy's openings live, then those are
 * read through the same pipeline - same role matching, same filters, same
 * scoring - so the result is that company's relevant open jobs, not all of
 * them.
 *
 * Tried cheapest and most certain first, stopping at the first that answers:
 *
 *  1. The curated list (companies_50lpa.json) and the watch list - a source
 *     someone already set up by hand.
 *  2. The ATS board APIs, probed with slugs made from the name. Free, and a
 *     board that exists answers in well under a second.
 *  3. A web search over the ATS hosts, when a Firecrawl key is set. Costs a
 *     credit, so it only runs when the free guesses missed.
 *  4. LinkedIn's public company page, which gives the id its logged-out job
 *     search filters on. Almost every company has one.
 *
 * Nothing is guessed at the end: if none of these find the company, it says
 * so rather than reading some other company that happens to share a slug.
 */

export interface ResolvedCompany extends TargetCompany {
  /** How it was found, so the page can say so. */
  via: 'list' | 'watch-list' | 'board' | 'search' | 'linkedin' | 'url';
}

const LIST_URL = new URL('../../../../companies_50lpa.json', import.meta.url);

/** Words that are not part of what people call the company. */
const SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|pvt|private|corp|corporation|co|company|plc|gmbh|technologies|technology|labs|group|holdings)\b/g;

/** "Swiggy Ltd." and "swiggy" are the same company; "Swiggy Instamart" is not. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(SUFFIXES, ' ').replace(/\s+/g, '');
}

export const sameCompany = (a: string, b: string): boolean => {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return Boolean(x) && x === y;
};

/** Board slugs a company of this name plausibly uses: "Mochi Health" -> mochihealth, mochi-health. */
export function slugCandidates(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(SUFFIXES, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  return [...new Set([words.join(''), words.join('-'), words.join('_')])];
}

const blank = (company: string, source: string, handle: string): TargetCompany => ({
  company,
  domain: '',
  source,
  handle,
  tier: '',
  sde2_ctc_lpa: '',
  india_locations: '',
});

/** A careers-page entry whose handle is a bare domain has nothing to read. */
const readable = (c: { source: string; handle: string }) => c.source !== 'careers-page' || /^https?:\/\//i.test(c.handle);

// ---- 1. already known ---------------------------------------------------------

function fromList(name: string): TargetCompany | null {
  const rows = JSON.parse(readFileSync(LIST_URL, 'utf8')) as TargetCompany[];
  const wanted = normalizeName(name);
  const domainLike = name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const row = rows.find((r) => readable(r) && (normalizeName(r.company) === wanted || r.domain?.toLowerCase() === domainLike));
  return row ?? null;
}

async function fromWatchList(name: string): Promise<TargetCompany | null> {
  const rows = await prisma.company.findMany({ select: { name: true, source: true, handle: true } });
  const row = rows.find((r) => readable(r) && sameCompany(r.name, name));
  return row ? blank(row.name, row.source, row.handle) : null;
}

// ---- 2. ATS board probes ------------------------------------------------------

interface Probe {
  source: 'greenhouse' | 'ashby' | 'lever' | 'workable';
  /** The open roles on the board, and the name it gives itself if it gives one. */
  read(slug: string): Promise<{ openings: number; name?: string }>;
}

const PROBES: Probe[] = [
  {
    source: 'greenhouse',
    async read(slug) {
      const [board, jobs] = await Promise.all([
        getJson<{ name?: string }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`),
        getJson<{ jobs?: unknown[] }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`),
      ]);
      return { openings: jobs.jobs?.length ?? 0, name: board.name };
    },
  },
  {
    source: 'ashby',
    async read(slug) {
      const data = await getJson<{ jobs?: unknown[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
      return { openings: data.jobs?.length ?? 0 };
    },
  },
  {
    source: 'lever',
    async read(slug) {
      const data = await getJson<unknown[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
      return { openings: Array.isArray(data) ? data.length : 0 };
    },
  },
  {
    source: 'workable',
    async read(slug) {
      const data = await getJson<{ name?: string; jobs?: unknown[] }>(
        `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`,
      );
      return { openings: data.jobs?.length ?? 0, name: data.name };
    },
  },
];

/**
 * Every board answering to one of the name's slugs, the one with the most
 * openings first. Boards are often left behind after a move between ATSs -
 * Stripe still has an empty Workable account, and "infosys" on Workable is
 * not Infosys - so an empty board only wins when nothing else answers.
 */
async function fromBoards(name: string): Promise<{ company: TargetCompany; openings: number } | null> {
  const attempts = slugCandidates(name).flatMap((slug) => PROBES.map((probe) => ({ slug, probe })));
  const found = (
    await Promise.all(
      attempts.map(async ({ slug, probe }) => {
        try {
          const r = await probe.read(slug);
          // A board that names itself something else is someone else's board.
          if (r.name && !sameCompany(r.name, name)) return null;
          return { slug, source: probe.source, openings: r.openings, name: r.name };
        } catch {
          return null;
        }
      }),
    )
  ).filter((f): f is NonNullable<typeof f> => f !== null);
  if (!found.length) return null;
  const order = PROBES.map((p) => p.source);
  found.sort((a, b) => b.openings - a.openings || order.indexOf(a.source) - order.indexOf(b.source));
  const best = found[0]!;
  return { company: blank(best.name || name, best.source, best.slug), openings: best.openings };
}

// ---- 3. web search -------------------------------------------------------------

/** "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/..." -> nvidia.wd5/NVIDIAExternalCareerSite */
export function parseWorkdayUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (!host) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? '') ? parts[1] : parts[0];
  return site ? `${host[1]}.${host[2]}/${site}` : null;
}

/** The source behind a posting or board URL, if it is one we can read. */
export function sourceFromUrl(url: string): { source: string; handle: string } | null {
  const board = parseBoardUrl(url);
  if (board) return { source: board.ats, handle: board.slug };
  const workday = parseWorkdayUrl(url);
  if (workday) return { source: 'workday', handle: workday };
  return null;
}

async function fromSearch(name: string, notes: string[]): Promise<TargetCompany | null> {
  if (!isFirecrawlConfigured()) return null;
  try {
    const { hits } = await firecrawlSearch(`"${name}" careers jobs`, {
      includeDomains: [...ATS_SEARCH_DOMAINS],
      limit: 10,
    });
    const counts = new Map<string, { source: string; handle: string; n: number }>();
    for (const hit of hits) {
      const ref = sourceFromUrl(hit.url);
      if (!ref) continue;
      // The hit has to be about this company, not merely mention it.
      const slugish = ref.handle.split(/[./]/)[0]!;
      if (!sameCompany(slugish, name) && !hit.title.toLowerCase().includes(name.trim().toLowerCase())) continue;
      const key = `${ref.source}:${ref.handle.toLowerCase()}`;
      const entry = counts.get(key) ?? { ...ref, n: 0 };
      entry.n++;
      counts.set(key, entry);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    return best ? blank(name, best.source, best.handle) : null;
  } catch (err) {
    notes.push(`Web search for ${name} failed: ${(err as Error).message}`);
    return null;
  }
}

// ---- 4. LinkedIn ----------------------------------------------------------------

const LINKEDIN = 'https://www.linkedin.com';

/** The id LinkedIn's job search filters on, read from the company's public page. */
async function linkedinId(slug: string, name: string): Promise<{ id: string; name: string } | null> {
  let html: string;
  try {
    html = await getText(`${LINKEDIN}/company/${encodeURIComponent(slug)}`);
  } catch {
    return null;
  }
  const title = html.match(/og:title" content="([^"|]+?)\s*\|\s*LinkedIn/)?.[1]?.trim();
  if (!title || !sameCompany(title, name)) return null;
  const id = html.match(/data-semaphore-content-type="COMPANY"[^>]*urn:li:organization:(\d+)/)?.[1]
    ?? html.match(/urn:li:organization:(\d+)/)?.[1];
  return id ? { id, name: title } : null;
}

/**
 * Company pages LinkedIn's own job search links to for this name. Covers the
 * slugs nobody would guess - Swiggy is "swiggy-in".
 */
async function linkedinSlugsFromJobSearch(name: string): Promise<string[]> {
  try {
    const params = new URLSearchParams({ keywords: name, start: '0' });
    const html = await getText(`${LINKEDIN}/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`);
    const slugs: string[] = [];
    for (const [, slug = '', label = ''] of html.matchAll(/linkedin\.com\/company\/([a-z0-9-]+)[^>]*>\s*([^<]+?)\s*</gi)) {
      if (sameCompany(label, name) && !slugs.includes(slug)) slugs.push(slug);
    }
    return slugs;
  } catch {
    return [];
  }
}

async function fromLinkedIn(name: string): Promise<TargetCompany | null> {
  for (const slug of slugCandidates(name).filter((s) => !s.includes('_'))) {
    const found = await linkedinId(slug, name);
    if (found) return blank(found.name, 'linkedin-company', found.id);
  }
  for (const slug of await linkedinSlugsFromJobSearch(name)) {
    const found = await linkedinId(slug, name);
    if (found) return blank(found.name, 'linkedin-company', found.id);
  }
  return null;
}

// ---- the whole lookup -------------------------------------------------------------

export async function resolveCompany(input: string): Promise<{ company: ResolvedCompany | null; notes: string[] }> {
  const notes: string[] = [];
  const name = input.trim();

  // A link to the board or a posting on it says exactly where to look.
  if (/^https?:\/\//i.test(name)) {
    const ref = sourceFromUrl(name);
    const label = ref ? ref.handle.split(/[./]/)[0]! : new URL(name).hostname.replace(/^www\./, '');
    const known = ref && (fromList(label) ?? (await fromWatchList(label)));
    if (known && known.source === ref.source) return { company: { ...known, via: 'url' }, notes };
    return {
      company: { ...blank(label, ref?.source ?? 'careers-page', ref?.handle ?? name), via: 'url' },
      notes,
    };
  }

  const listed = fromList(name);
  if (listed) return { company: { ...listed, via: 'list' }, notes };
  const watched = await fromWatchList(name);
  if (watched) return { company: { ...watched, via: 'watch-list' }, notes };
  const board = await fromBoards(name);
  if (board && board.openings > 0) return { company: { ...board.company, via: 'board' }, notes };
  const searched = await fromSearch(name, notes);
  if (searched) return { company: { ...searched, via: 'search' }, notes };
  const linkedin = await fromLinkedIn(name);
  if (linkedin) return { company: { ...linkedin, via: 'linkedin' }, notes };
  if (board) {
    notes.push(`The only board found for ${name} (${board.company.source} "${board.company.handle}") has no open roles, and may not be theirs.`);
    return { company: { ...board.company, via: 'board' }, notes };
  }
  return { company: null, notes };
}
