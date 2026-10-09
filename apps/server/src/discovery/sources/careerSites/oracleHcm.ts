import { getJson } from '../http.js';
import { remoteFromLabel, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { hydrate, searchPaged, toDate, uniqueBy } from './shared.js';

interface Requisition {
  Id: string;
  Title: string;
  /** The day it was posted, "2026-09-30". */
  PostedDate?: string;
  PrimaryLocation?: string;
  WorkplaceTypeCode?: string;
  secondaryLocations?: { Name?: string }[];
}

interface Detail {
  ExternalDescriptionStr?: string;
  ExternalResponsibilitiesStr?: string;
  ExternalQualificationsStr?: string;
  WorkplaceType?: string;
}

/** "ORA_HYBRID" -> "hybrid", the label remoteFromLabel understands. */
const workplace = (code: string | undefined): string | undefined => code?.replace(/^ORA_/, '').replace(/_/g, ' ').toLowerCase();

/**
 * Oracle Recruiting Cloud's candidate experience, which Oracle, American
 * Express and Akamai run their careers sites on.
 *
 * Handle: `<host>|<siteNumber>`, e.g. `eeho.fa.us2.oraclecloud.com|CX_45001`.
 * The host is the Oracle Cloud pod, not the vanity domain: the vanity domain
 * serves the page, and the page reads its jobs from the pod.
 */
export const oracleHcmSource: Source = {
  id: 'oracle-hcm',
  handleHint: 'pod host|site, e.g. "eeho.fa.us2.oraclecloud.com|CX_45001"',

  async fetchJobs(handle, hints) {
    const [host, site] = handle.split('|');
    if (!host || !site) throw new Error(`Oracle handle should look like "host|CX_1", got "${handle}"`);
    const api = `https://${host}/hcmRestApi/resources/latest`;

    const reqs = await searchPaged<Requisition>(hints, 25, async (query, offset) => {
      const finder = [
        `findReqs;siteNumber=${site}`,
        'limit=25',
        `offset=${offset}`,
        query && `keyword="${query.replace(/"/g, '')}"`,
        hints?.country && `location="${hints.country.name}"`,
        'sortBy=POSTING_DATES_DESC',
      ].filter(Boolean).join(',');
      const page = await getJson<{ items?: { TotalJobsCount?: number; requisitionList?: Requisition[] }[] }>(
        `${api}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finder)}`,
      );
      const result = page.items?.[0];
      return { items: result?.requisitionList ?? [], total: result?.TotalJobsCount };
    });

    return hydrate(uniqueBy(reqs, (r) => r.Id), async (r): Promise<DiscoveredJob> => {
      const finder = `ById;Id="${r.Id}",siteNumber=${site}`;
      const d = (await getJson<{ items?: Detail[] }>(
        `${api}/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=${encodeURIComponent(finder)}`,
      )).items?.[0] ?? {};
      const location = [r.PrimaryLocation, ...(r.secondaryLocations ?? []).map((l) => l.Name)].filter(Boolean).join('; ');
      const description = [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr]
        .map((s) => stripHtml(s ?? ''))
        .filter(Boolean)
        .join('\n\n');
      return {
        url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
        ats: 'oracle-hcm',
        title: r.Title,
        companyName: host.split('.')[0]!,
        location: location || undefined,
        remote: remoteFromLabel(d.WorkplaceType ?? workplace(r.WorkplaceTypeCode), `${location} ${description.slice(0, 1200)}`),
        descriptionText: description,
        postedAt: toDate(r.PostedDate),
      };
    }, hints);
  },
};
