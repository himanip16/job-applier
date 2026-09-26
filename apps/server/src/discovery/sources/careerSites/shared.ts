/**
 * What every careers-site crawler needs, so each one only describes its site.
 *
 * The crawlers differ in URL shape and field names and nothing else. Paging
 * through a search once per role title, reading detail pages politely under a
 * cap, dropping duplicates and deciding "remote" from a platform's own label
 * are the same everywhere, and live here once. HTTP and text helpers shared
 * with the ATS boards are in ../http.ts and ../text.ts.
 */
import type { Country } from '@ja/shared';
import { sleep } from '../http.js';
import type { DiscoveredJob, FetchHints } from '../types.js';

/** Most postings any one site contributes to a single run. */
export const MAX_PER_SITE = 60;
/** Most detail pages fetched per site, for sources whose list has no description. */
export const MAX_DETAILS = 30;

// ------------------------------------------------------------------- queries ---

/** The searches to run: each role title, or one empty search for "everything". */
export function queriesFrom(hints?: FetchHints): string[] {
  const qs = (hints?.queries ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 3);
  return qs.length ? qs : [''];
}

/**
 * Run a paged search once per query, collecting every page's items.
 *
 * `fetchPage` gets the query and the zero-based offset of the page's first
 * item, and returns that page plus the total if the site reports one. Paging
 * stops at MAX_PER_SITE, on a short page, or once the total is reached.
 */
export async function searchPaged<T>(
  hints: FetchHints | undefined,
  pageSize: number,
  fetchPage: (query: string, offset: number) => Promise<{ items: T[]; total?: number }>,
  pauseMs = 200,
): Promise<T[]> {
  const all: T[] = [];
  for (const query of queriesFrom(hints)) {
    for (let offset = 0; offset < MAX_PER_SITE; offset += pageSize) {
      if (offset > 0) await sleep(pauseMs);
      const { items, total } = await fetchPage(query, offset);
      all.push(...items);
      if (items.length < pageSize || (total !== undefined && offset + pageSize >= total)) break;
    }
  }
  return all;
}

// ------------------------------------------------------------------- results ---

/** First item per key; several searches return the same posting. */
export function uniqueBy<T>(items: T[], key: (item: T) => string | number): T[] {
  return [...new Map(items.map((i) => [key(i), i] as const)).values()];
}

export const dedupe = (jobs: DiscoveredJob[]): DiscoveredJob[] => uniqueBy(jobs, (j) => j.url);

/**
 * Read one detail page per item, one at a time with a pause, stopping at
 * MAX_DETAILS. An item whose read fails is dropped (`null`), so one dead
 * posting does not cost the rest.
 */
export async function hydrate<T>(items: T[], read: (item: T) => Promise<DiscoveredJob | null>): Promise<DiscoveredJob[]> {
  const out: DiscoveredJob[] = [];
  for (const [i, item] of items.slice(0, MAX_DETAILS).entries()) {
    if (i > 0) await sleep(150);
    const job = await read(item).catch(() => null);
    if (job) out.push(job);
  }
  return dedupe(out);
}

/** Whatever a fetch returns, or `fallback` if it throws: for optional extras like a description. */
export const orElse = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

// ------------------------------------------------------------------ fields ---

export const fromEpochSeconds = (s: number | undefined): Date | undefined =>
  typeof s === 'number' && s > 0 ? new Date(s * 1000) : undefined;

export const toDate = (s: string | undefined): Date | undefined => (s ? new Date(s) : undefined);

/** Whether free text names this country by name or a city alias. */
export function mentionsCountry(text: string, country: Country): boolean {
  const t = text.toLowerCase();
  return [country.name.toLowerCase(), ...country.aliases].some((w) =>
    new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(t),
  );
}

/** How many words of the searched role titles a posting title shares. */
export function queryOverlap(title: string, hints?: FetchHints): number {
  const words = new Set(title.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2));
  return queriesFrom(hints)
    .flatMap((q) => q.toLowerCase().split(/[^a-z0-9+#]+/))
    .filter((w) => w.length > 2 && words.has(w)).length;
}
