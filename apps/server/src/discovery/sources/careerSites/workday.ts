import { getJson, postJson } from '../http.js';
import { remoteFromLabel, stripHtml } from '../text.js';
import type { Country } from '@ja/shared';
import type { DiscoveredJob, Source } from '../types.js';
import { hydrate, mentionsCountry, searchPaged, toDate, uniqueBy } from './shared.js';

interface Listing {
  title: string;
  externalPath: string;
  locationsText?: string;
}

interface Facet {
  facetParameter?: string;
  descriptor?: string;
  id?: string;
  values?: Facet[];
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

    // Filter by the board's own location facet when it has one. Typing the
    // country into the search box instead only works on some tenants: it is
    // ANDed with the role title, and Postman's board answers "Software
    // Engineer India" with nothing while listing several in Bangalore.
    const appliedFacets = hints?.country
      ? countryFacet((await postJson<{ facets?: Facet[] }>(`${api}/jobs`, { appliedFacets: {}, limit: 1, offset: 0, searchText: '' })).facets ?? [], hints.country)
      : undefined;

    const listings = await searchPaged<Listing>(hints, 20, async (query, offset) => {
      const searchText = appliedFacets ? query : [query, hints?.country?.name].filter(Boolean).join(' ');
      const page = await postJson<{ jobPostings?: Listing[]; total?: number }>(`${api}/jobs`, {
        appliedFacets: appliedFacets ?? {},
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
    }, hints);
  },
};

/**
 * The facet that narrows a board to one country, or undefined if it has none.
 *
 * Tenants name their location facets differently (`locationCountry`,
 * `locationHierarchy1`, a custom field, or only per-city `locations`). A value
 * that is exactly the country is used when there is one; otherwise every city
 * value in that country from the location facet that has the most of them.
 */
export function countryFacet(facets: Facet[], country: Country): Record<string, string[]> | undefined {
  const groups = new Map<string, Facet[]>();
  const visit = (list: Facet[], param?: string) => {
    for (const f of list) {
      const key = f.facetParameter ?? param;
      if (f.values) visit(f.values, key);
      else if (key && f.id && f.descriptor && /location|country/i.test(key) && mentionsCountry(f.descriptor, country)) {
        groups.set(key, [...(groups.get(key) ?? []), f]);
      }
    }
  };
  visit(facets);
  const exact = [...groups].find(([, vs]) => vs.some((v) => v.descriptor!.trim().toLowerCase() === country.name.toLowerCase()));
  if (exact) return { [exact[0]]: exact[1].filter((v) => v.descriptor!.trim().toLowerCase() === country.name.toLowerCase()).map((v) => v.id!) };
  const widest = [...groups].sort((a, b) => b[1].length - a[1].length)[0];
  return widest ? { [widest[0]]: widest[1].map((v) => v.id!) } : undefined;
}
