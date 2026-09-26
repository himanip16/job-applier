import { getJson, postJson } from '../http.js';
import { remoteFromLabel, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { hydrate, searchPaged, toDate, uniqueBy } from './shared.js';

interface Listing {
  title: string;
  externalPath: string;
  locationsText?: string;
}

interface Detail {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    startDate?: string;
    externalUrl?: string;
    remoteType?: string;
  };
}

/**
 * Workday's candidate-experience API, the one every myworkdayjobs.com page calls.
 *
 * Handle: `<tenant>.<wdN>/<site>`, e.g. `nvidia.wd5/NVIDIAExternalCareerSite` for
 * https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite. The listing has
 * no description and often says "3 Locations", so each posting is read in full.
 */
export const workdaySource: Source = {
  id: 'workday',
  handleHint: 'tenant.wdN/site, e.g. "nvidia.wd5/NVIDIAExternalCareerSite"',

  async fetchJobs(handle, hints) {
    const m = handle.match(/^([a-z0-9-]+)\.(wd\d+)\/([A-Za-z0-9_-]+)$/i);
    if (!m) throw new Error(`Workday handle should look like "tenant.wd5/Site", got "${handle}"`);
    const [, tenant, wd, site] = m as unknown as [string, string, string, string];
    const origin = `https://${tenant}.${wd}.myworkdayjobs.com`;
    const api = `${origin}/wday/cxs/${tenant}/${site}`;

    const listings = await searchPaged<Listing>(hints, 20, async (query, offset) => {
      // Full-text search covers location too, so naming the country narrows a
      // worldwide board without needing Workday's per-tenant facet ids.
      const searchText = [query, hints?.country?.name].filter(Boolean).join(' ');
      const page = await postJson<{ jobPostings?: Listing[]; total?: number }>(`${api}/jobs`, {
        appliedFacets: {},
        limit: 20,
        offset,
        searchText,
      });
      return { items: page.jobPostings ?? [], total: page.total };
    });

    return hydrate(uniqueBy(listings, (l) => l.externalPath), async (l): Promise<DiscoveredJob> => {
      const d = (await getJson<Detail>(`${api}${l.externalPath}`)).jobPostingInfo ?? {};
      const location = [d.location, ...(d.additionalLocations ?? [])].filter(Boolean).join('; ');
      const description = stripHtml(d.jobDescription ?? '');
      return {
        url: d.externalUrl ?? `${origin}/${site}${l.externalPath}`,
        ats: 'workday',
        title: d.title ?? l.title,
        companyName: tenant,
        location: location || l.locationsText,
        remote: remoteFromLabel(d.remoteType, `${location} ${description.slice(0, 1200)}`),
        descriptionText: description,
        postedAt: toDate(d.startDate),
      };
    });
  },
};
