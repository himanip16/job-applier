import { getJson } from '../http.js';
import { remoteFrom, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { hydrate, searchPaged, toDate, uniqueBy } from './shared.js';

interface Posting {
  id: string;
  name: string;
  /** API URL of the full posting. */
  ref: string;
  releasedDate?: string;
  location?: { fullLocation?: string; city?: string; remote?: boolean; hybrid?: boolean };
  company?: { name?: string };
}

interface Detail {
  postingUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

/** SmartRecruiters' public postings API. Handle: the company id, e.g. "ServiceNow". */
export const smartRecruitersSource: Source = {
  id: 'smartrecruiters',
  handleHint: 'company id, e.g. the "ServiceNow" in jobs.smartrecruiters.com/ServiceNow',

  async fetchJobs(handle, hints) {
    const postings = await searchPaged<Posting>(hints, 100, async (query, offset) => {
      const params = new URLSearchParams({ limit: '100', offset: String(offset) });
      if (query) params.set('q', query);
      if (hints?.country) params.set('country', hints.country.code.toLowerCase());
      const page = await getJson<{ content?: Posting[]; totalFound?: number }>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(handle)}/postings?${params}`,
      );
      return { items: page.content ?? [], total: page.totalFound };
    });

    return hydrate(uniqueBy(postings, (p) => p.id), async (p): Promise<DiscoveredJob> => {
      const d = await getJson<Detail>(p.ref);
      const location = (p.location?.fullLocation?.replace(/,\s*,/g, ',') ?? p.location?.city) || undefined;
      return {
        url: d.postingUrl ?? `https://jobs.smartrecruiters.com/${handle}/${p.id}`,
        ats: 'smartrecruiters',
        title: p.name,
        companyName: p.company?.name || handle,
        location,
        remote: remoteFrom(
          p.location?.remote ? 'remote' : p.location?.hybrid ? 'hybrid' : p.location ? 'onsite' : 'unspecified',
          location ?? '',
        ),
        descriptionText: Object.values(d.jobAd?.sections ?? {})
          .map((s) => [s.title, stripHtml(s.text ?? '')].filter(Boolean).join('\n'))
          .join('\n\n'),
        postedAt: toDate(p.releasedDate),
      };
    }, hints);
  },
};
