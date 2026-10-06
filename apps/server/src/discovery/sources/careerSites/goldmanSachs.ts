import { postJson } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { dedupe, searchPaged } from './shared.js';

interface Role {
  roleId: string;
  jobTitle: string;
  corporateTitle?: string;
  locations?: { city?: string; state?: string; country?: string }[];
  status?: string;
  descriptionHtml?: string;
  externalSource?: { sourceId?: string };
}

const QUERY = `query GetRoles($searchQueryInput: RoleSearchQueryInput!) {
  roleSearch(searchQueryInput: $searchQueryInput) {
    totalCount
    items { roleId jobTitle corporateTitle status descriptionHtml locations { city state country } externalSource { sourceId } }
  }
}`;

/**
 * Goldman Sachs (higher.gs.com). The results page asks a public GraphQL API,
 * which searches by text and country server-side and returns each role's full
 * description, so nothing needs hydrating.
 */
export const goldmanSachsSource: Source = {
  id: 'goldman-sachs',
  handleHint: 'unused - Goldman Sachs careers',

  async fetchJobs(_handle, hints) {
    const pageSize = 20;
    const roles = await searchPaged<Role>(hints, pageSize, async (query, offset) => {
      const res = await postJson<{ data?: { roleSearch?: { totalCount: number; items: Role[] } }; errors?: { message: string }[] }>(
        'https://api-higher.gs.com/gateway/api/v1/graphql',
        {
          operationName: 'GetRoles',
          query: QUERY,
          variables: {
            searchQueryInput: {
              page: { pageSize, pageNumber: offset / pageSize + 1 },
              sort: { sortStrategy: 'RELEVANCE', sortOrder: 'DESC' },
              filters: hints?.country
                ? [{ filterCategoryType: 'LOCATION', filters: [{ filter: hints.country.name, subFilters: [] }] }]
                : [],
              experiences: ['EARLY_CAREER', 'PROFESSIONAL'],
              searchTerm: query,
            },
          },
        },
      );
      const search = res.data?.roleSearch;
      if (!search) throw new Error(`Goldman Sachs search failed: ${res.errors?.[0]?.message ?? 'no data'}`);
      return { items: search.items, total: search.totalCount };
    });

    return dedupe(
      roles
        .filter((r) => !r.status || r.status === 'POSTED')
        .map((r): DiscoveredJob => {
          const location = (r.locations ?? [])
            .map((l) => [l.city, l.country].filter(Boolean).join(', '))
            .filter(Boolean)
            .join('; ');
          return {
            url: `https://higher.gs.com/roles/${r.externalSource?.sourceId ?? r.roleId.split('_')[0]}`,
            ats: 'goldman-sachs',
            title: r.jobTitle.trim(),
            companyName: 'Goldman Sachs',
            location: location || undefined,
            remote: looksRemote(location),
            descriptionText: stripHtml(r.descriptionHtml ?? ''),
            // The API gives no posting date.
          };
        }),
    );
  },
};
