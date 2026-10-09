import { getBrowserJson } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { dedupe, searchPaged, toDate } from './shared.js';

/** amazon.jobs filters on ISO 3166 alpha-3 codes, not the alpha-2 the app uses. */
const ALPHA3: Record<string, string> = {
  IN: 'IND', GB: 'GBR', US: 'USA', CA: 'CAN', IE: 'IRL', DE: 'DEU', NL: 'NLD', FR: 'FRA', ES: 'ESP',
  PT: 'PRT', PL: 'POL', SE: 'SWE', CH: 'CHE', SG: 'SGP', AE: 'ARE', AU: 'AUS', JP: 'JPN',
};

interface Result {
  title: string;
  job_path: string;
  normalized_location?: string;
  location?: string;
  /** "September 25, 2026" */
  posted_date?: string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
}

/**
 * Amazon's own careers site. Its search page is backed by a public JSON
 * endpoint, search.json, that returns full descriptions and qualifications,
 * so no posting has to be opened separately.
 */
export const amazonSource: Source = {
  id: 'amazon',
  handleHint: 'unused - amazon.jobs',

  async fetchJobs(_handle, hints) {
    const country = hints?.country ? ALPHA3[hints.country.code] : undefined;
    const results = await searchPaged<Result>(hints, 100, async (query, offset) => {
      const params = new URLSearchParams({ base_query: query, result_limit: '100', offset: String(offset), sort: 'recent' });
      if (country) params.set('country', country);
      const page = await getBrowserJson<{ jobs?: Result[]; hits?: number }>(`https://www.amazon.jobs/en/search.json?${params}`);
      return { items: page.jobs ?? [], total: page.hits };
    });
    return dedupe(results.map(toJob));
  },
};

function toJob(r: Result): DiscoveredJob {
  const location = r.normalized_location || r.location || undefined;
  const posted = toDate(r.posted_date);
  return {
    url: `https://www.amazon.jobs${r.job_path}`,
    ats: 'amazon',
    title: r.title,
    companyName: 'Amazon',
    location,
    remote: looksRemote(`${location ?? ''} ${r.title}`),
    descriptionText: [r.description, r.basic_qualifications, r.preferred_qualifications]
      .filter((s): s is string => !!s)
      .map(stripHtml)
      .join('\n\n'),
    postedAt: posted && !Number.isNaN(posted.getTime()) ? posted : undefined,
  };
}
