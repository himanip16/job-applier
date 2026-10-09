import { getBrowserPage, postForm } from '../http.js';
import { jobPostingsFromLd } from '../jobPostingLd.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, FetchHints, Source } from '../types.js';
import { hydrate, queriesFrom, queryOverlap, uniqueBy } from './shared.js';

interface Listing {
  id: string;
  title: string;
  locations?: string[];
}

interface Office {
  location_display_name: string;
  country: string;
}

const ORIGIN = 'https://www.metacareers.com';

/**
 * The persisted GraphQL queries the job search page runs, by id. Meta changes
 * these when it redeploys the page; a stale one fails loudly with an error.
 */
const DOC = { results: '27129360303422352', locations: '24867916029505828' };

/**
 * Meta careers (metacareers.com). The site refuses anything that does not look
 * like a browser navigation, and its search is a GraphQL call guarded by a
 * per-page token (`lsd`). So: load the search page once for the token, ask for
 * the offices in the searched country, then run the search query. Each
 * posting's page carries a schema.org JobPosting with the full description.
 */
export const metaSource: Source = {
  id: 'meta',
  handleHint: 'unused - Meta careers',

  async fetchJobs(_handle, hints) {
    const page = await getBrowserPage(`${ORIGIN}/jobsearch/`);
    const lsd = page.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
    if (!lsd) throw new Error('Meta careers page changed shape: no LSD token');
    const graphql = <T>(docId: string, variables: unknown) =>
      postForm<{ data?: T; errors?: { message: string }[] }>(
        `${ORIGIN}/graphql`,
        { lsd, __a: '1', variables: JSON.stringify(variables), doc_id: docId },
        { 'x-fb-lsd': lsd, origin: ORIGIN, referer: `${ORIGIN}/jobsearch/` },
      ).then((res) => {
        if (!res.data) throw new Error(`Meta careers search failed: ${res.errors?.[0]?.message ?? 'no data'}`);
        return res.data;
      });

    // Search the country's offices by name; Meta's text search alone matches worldwide.
    let offices: string[] = [];
    if (hints?.country) {
      const { job_search_filters } = await graphql<{ job_search_filters: { locations: Office[] } }>(DOC.locations, {});
      offices = job_search_filters.locations
        .filter((o) => o.country.toLowerCase() === hints.country!.name.toLowerCase())
        .map((o) => o.location_display_name);
      if (!offices.length) return [];
    }

    // A country's whole list is small (India: a few dozen), so read it whole
    // and let the caller's title filter decide. Worldwide, search by title.
    const queries = offices.length ? [''] : queriesFrom(hints);
    const listings: Listing[] = [];
    for (const q of queries) {
      const { job_search_with_featured_jobs_v2: res } = await graphql<{ job_search_with_featured_jobs_v2: { all_jobs: Listing[] } }>(
        DOC.results,
        {
          search_input: {
            q, divisions: [], offices, roles: [], leadership_levels: [], saved_jobs: [], saved_searches: [],
            sub_teams: [], teams: [], is_leadership: false, is_remote_only: false, sort_by_new: false, results_per_page: null,
          },
          viewasUserID: null,
          isLoggedIn: false,
        },
      );
      listings.push(...res.all_jobs);
    }

    return hydrate(rank(uniqueBy(listings, (l) => l.id), hints), readPosting, hints);
  },
};

/** Closest titles first, since only so many detail pages are read. */
const rank = (listings: Listing[], hints?: FetchHints) =>
  [...listings].sort((a, b) => queryOverlap(b.title, hints) - queryOverlap(a.title, hints));

async function readPosting(l: Listing): Promise<DiscoveredJob> {
  const url = `${ORIGIN}/profile/job_details/${l.id}/`;
  const html = await getBrowserPage(url);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const ld = jobPostingsFromLd(blocks)[0];
  const location = (l.locations ?? []).join('; ') || ld?.location;
  return {
    url,
    ats: 'meta',
    title: l.title.trim(),
    companyName: 'Meta',
    location: location || undefined,
    remote: ld?.remote || looksRemote(location ?? ''),
    descriptionText: fullDescription(blocks) || ld?.descriptionText || '',
    postedAt: ld?.postedAt,
  };
}

/**
 * Meta's JobPosting splits the text into description, responsibilities and
 * qualifications; the shared parser keeps only the first, which is a paragraph.
 */
function fullDescription(blocks: string[]): string {
  for (const block of blocks) {
    try {
      const node = JSON.parse(block) as Record<string, unknown>;
      if (node['@type'] !== 'JobPosting') continue;
      return ['description', 'responsibilities', 'qualifications', 'preferredQualifications']
        .map((k) => (typeof node[k] === 'string' ? stripHtml(node[k] as string) : ''))
        .filter(Boolean)
        .join('\n\n');
    } catch {
      // A malformed block: fall back to the shared parser's reading.
    }
  }
  return '';
}
