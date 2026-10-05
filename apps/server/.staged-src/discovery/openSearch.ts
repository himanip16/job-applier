import type { DiscoveredJob } from './sources/index.js';
import { ATS_SEARCH_DOMAINS, boardKey, companyNameFromTitle, parseBoardUrl, type BoardRef } from './boardUrls.js';
import { firecrawlSearch, isFirecrawlConfigured, type SearchHit } from './firecrawl.js';
import { canonicalUrl, fallbackJobsFromHits } from './jobSearchUtils.js';

/**
 * Open search: who else is hiring for these roles, beyond the listed companies.
 *
 * The list in companies_50lpa.json is read first and always. This adds the
 * boards nobody listed: a web search for the plan's queries, restricted to the
 * ATS hosts we can apply on, reduced to the boards those hits live on. Each
 * board is then read through its own API like a listed company, so a lead
 * found this way goes through the same filters and scoring.
 *
 * It needs a Firecrawl key and spends search credits, so without one it is
 * skipped with a note rather than failing the run.
 */

export interface FoundBoard {
  ref: BoardRef;
  /** The company's own name where the search result title gave it. */
  name: string;
}

export interface OpenSearchResult {
  ran: boolean;
  boards: FoundBoard[];
  queries: { query: string; hits: number }[];
  creditsUsed: number;
  notes: string[];
  errors: { where: string; error: string }[];
  /** The postings search matched, for when a board's API will not answer. */
  fallback(ref: BoardRef, name: string): DiscoveredJob[];
}

export type SearchFn = (
  query: string,
  opts: { includeDomains: string[]; limit: number; country?: string },
) => Promise<{ hits: SearchHit[]; creditsUsed: number; warning?: string }>;

/** Search results read per query. Firecrawl charges per result page, not per hit. */
const RESULTS_PER_QUERY = 20;

export async function openSearch(
  queries: string[],
  opts: {
    country?: string;
    /** boardKey()s already read from the list, so they are not read twice. */
    skip: Set<string>;
    /** Most new boards to read in one run. */
    maxBoards: number;
    search?: SearchFn;
  },
): Promise<OpenSearchResult> {
  const matchedUrls = new Set<string>();
  const hitsByUrl = new Map<string, SearchHit>();
  const result: OpenSearchResult = {
    ran: false,
    boards: [],
    queries: [],
    creditsUsed: 0,
    notes: [],
    errors: [],
    fallback: (ref, name) => fallbackJobsFromHits(ref, matchedUrls, hitsByUrl, name),
  };

  const search = opts.search ?? (isFirecrawlConfigured() ? (q, o) => firecrawlSearch(q, o) : null);
  if (!search) {
    result.notes.push(
      'Open search was skipped: it needs a Firecrawl API key (Settings). Only the listed companies were read.',
    );
    return result;
  }
  if (!queries.length) return result;
  result.ran = true;

  const found = new Map<string, FoundBoard>();
  for (const query of queries) {
    try {
      const { hits, creditsUsed, warning } = await search(query, {
        includeDomains: [...ATS_SEARCH_DOMAINS],
        limit: RESULTS_PER_QUERY,
        country: opts.country,
      });
      result.creditsUsed += creditsUsed;
      if (warning) result.notes.push(warning);
      let usable = 0;
      for (const hit of hits) {
        const ref = parseBoardUrl(hit.url);
        if (!ref) continue;
        usable++;
        matchedUrls.add(canonicalUrl(hit.url));
        hitsByUrl.set(canonicalUrl(hit.url), hit);
        const key = boardKey(ref);
        if (!opts.skip.has(key) && !found.has(key)) found.set(key, { ref, name: companyNameFromTitle(hit.title, ref.slug) });
      }
      result.queries.push({ query, hits: usable });
    } catch (err) {
      result.errors.push({ where: `search "${query}"`, error: (err as Error).message });
      result.queries.push({ query, hits: 0 });
      // A dead key or an empty balance fails every remaining query the same way.
      if (!(err as { transient?: boolean }).transient) break;
    }
  }

  result.boards = [...found.values()].slice(0, opts.maxBoards);
  if (found.size > result.boards.length) {
    result.notes.push(
      `Open search found ${found.size} companies not on the list; read the first ${result.boards.length}. Run it again to pick up the rest.`,
    );
  }
  return result;
}
