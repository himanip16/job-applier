import { getJson } from '../http.js';
import { remoteFromLabel, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { dedupe, searchPaged, toDate } from './shared.js';

interface Job {
  data: {
    slug: string;
    title: string;
    description?: string;
    full_location?: string;
    city?: string;
    country?: string;
    location_type?: string;
    posted_date?: string;
  };
}

/**
 * Jibe (iCIMS' candidate site), which Booking.com runs on.
 * Handle: the host, e.g. "jobs.booking.com".
 */
export const jibeSource: Source = {
  id: 'jibe',
  handleHint: 'careers host, e.g. "jobs.booking.com"',

  async fetchJobs(handle, hints) {
    // "jobs.booking.com" -> "booking": the tenant, which is also the URL prefix.
    const tenant = handle.split('.')[1] ?? handle;
    const jobs = await searchPaged<Job>(hints, 50, async (query, offset) => {
      const params = new URLSearchParams({ keywords: query, page: String(offset / 50 + 1), limit: '50' });
      if (hints?.country) params.set('location', hints.country.name);
      const res = await getJson<{ jobs?: Job[]; totalCount?: number }>(`https://${handle}/api/jobs?${params}`);
      return { items: res.jobs ?? [], total: res.totalCount };
    });
    return dedupe(jobs.map(({ data: d }): DiscoveredJob => {
      const location = d.full_location ?? [d.city, d.country].filter(Boolean).join(', ');
      return {
        url: `https://${handle}/${tenant}/jobs/${d.slug}`,
        ats: 'jibe',
        title: d.title,
        companyName: tenant,
        location: location || undefined,
        remote: remoteFromLabel(d.location_type, location),
        descriptionText: stripHtml(d.description ?? ''),
        postedAt: toDate(d.posted_date),
      };
    }));
  },
};
