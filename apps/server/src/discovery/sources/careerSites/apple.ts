import { getText } from '../http.js';
import { stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { dedupe, searchPaged, toDate } from './shared.js';

/** Apple's own location slugs, which are not ISO codes. */
const LOCATIONS: Record<string, string> = {
  IN: 'india-INDC',
  US: 'united-states-USA',
  GB: 'united-kingdom-GBR',
  IE: 'ireland-IRL',
  DE: 'germany-DEU',
  CA: 'canada-CAN',
  NL: 'netherlands-NLD',
  FR: 'france-FRA',
  SG: 'singapore-SGP',
};

interface Result {
  positionId: string;
  postingTitle: string;
  transformedPostingTitle: string;
  jobSummary?: string;
  postDateInGMT?: string;
  homeOffice?: boolean;
  locations?: { name?: string; city?: string; countryName?: string }[];
}

/** Apple careers: the search page embeds its results as router hydration data. */
export const appleSource: Source = {
  id: 'apple',
  handleHint: 'unused - Apple careers',

  async fetchJobs(_handle, hints) {
    const location = hints?.country ? LOCATIONS[hints.country.code] : undefined;
    const results = await searchPaged<Result>(
      hints,
      20,
      async (query, offset) => {
        const params = new URLSearchParams({ search: query, page: String(offset / 20 + 1) });
        if (location) params.set('location', location);
        const html = await getText(`https://jobs.apple.com/en-us/search?${params}`);
        const m = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/);
        if (!m) throw new Error('Apple careers page changed shape: no hydration data');
        // A JSON string literal holding JSON: unescape it, then parse it.
        const data = JSON.parse(JSON.parse(`"${m[1]}"`) as string) as {
          loaderData?: { search?: { searchResults?: Result[] } };
        };
        return { items: data.loaderData?.search?.searchResults ?? [] };
      },
      300,
    );
    return dedupe(results.map(toJob));
  },
};

function toJob(r: Result): DiscoveredJob {
  const location = (r.locations ?? [])
    .map((l) => [l.city, l.countryName].filter(Boolean).join(', ') || l.name)
    .join('; ');
  return {
    url: `https://jobs.apple.com/en-us/details/${r.positionId}/${r.transformedPostingTitle}`,
    ats: 'apple',
    title: r.postingTitle,
    companyName: 'Apple',
    location: location || undefined,
    remote: r.homeOffice === true,
    descriptionText: stripHtml(r.jobSummary ?? ''),
    postedAt: toDate(r.postDateInGMT),
  };
}
