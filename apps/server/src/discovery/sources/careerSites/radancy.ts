import { getBrowserJson, getText } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { hydrate, orElse, searchPaged, uniqueBy } from './shared.js';

interface Card {
  path: string;
  title: string;
  location: string;
}

/**
 * Radancy (TalentBrew) sites, which Intuit runs on. The search endpoint returns
 * a rendered HTML fragment rather than JSON; each posting's page is then read
 * for its description. Handle: the host, e.g. "jobs.intuit.com".
 */
export const radancySource: Source = {
  id: 'radancy',
  handleHint: 'careers host, e.g. "jobs.intuit.com"',

  async fetchJobs(handle, hints) {
    const cards = await searchPaged<Card>(
      hints,
      25,
      async (query, offset) => {
        const params = new URLSearchParams({
          CurrentPage: String(offset / 25 + 1),
          RecordsPerPage: '25',
          Keywords: query,
          Location: hints?.country?.name ?? '',
          SearchResultsModuleName: 'Search Results',
          SearchFiltersModuleName: 'Search Filters',
          SortCriteria: '0',
          SortDirection: '0',
          SearchType: '1',
        });
        const res = await getBrowserJson<{ results?: string }>(`https://${handle}/search-jobs/results?${params}`, {
          'x-requested-with': 'XMLHttpRequest',
        });
        return { items: parseCards(res.results ?? '') };
      },
      300,
    );

    return hydrate(uniqueBy(cards, (c) => c.path), async (c): Promise<DiscoveredJob> => ({
      url: `https://${handle}${c.path}`,
      ats: 'radancy',
      title: c.title,
      companyName: handle.split('.')[1] ?? handle,
      location: c.location || undefined,
      remote: looksRemote(c.location),
      descriptionText: await orElse(readDescription(`https://${handle}${c.path}`), ''),
    }));
  },
};

function parseCards(html: string): Card[] {
  return [...html.matchAll(/<a href="(\/job\/[^"]+)"[^>]*data-title="([^"]*)"[\s\S]*?(?:class="job-location">([^<]*)<)?[\s\S]*?<\/a>/g)].map(
    ([, path = '', title = '', loc = '']) => {
      // "Multiple Locations" says nothing; the first city is in the URL path.
      const cityFromPath = path.split('/')[2]?.replace(/-/g, ' ') ?? '';
      const location = loc.trim();
      return { path, title: stripHtml(title), location: !location || /multiple/i.test(location) ? cityFromPath : location };
    },
  );
}

async function readDescription(url: string): Promise<string> {
  // The posting is the job-description section; everything after it is
  // "similar jobs" and site chrome, which would drown the scorer.
  const html = await getText(url);
  return stripHtml(html.match(/<section[^>]*class="job-description[\s\S]*?<\/section>/)?.[0] ?? '');
}
