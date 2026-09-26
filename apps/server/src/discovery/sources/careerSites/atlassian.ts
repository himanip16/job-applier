import { getBrowserJson } from '../http.js';
import { stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { mentionsCountry } from './shared.js';

interface Listing {
  id: string | number;
  title: string;
  locations?: string[];
  overview?: string;
  responsibilities?: string;
  qualifications?: string;
  applyUrl?: string;
  portalJobPost?: { portalUrl?: string };
}

/** Atlassian: one JSON document with every opening and its full text. */
export const atlassianSource: Source = {
  id: 'atlassian',
  handleHint: 'unused - Atlassian careers',

  async fetchJobs(_handle, hints) {
    const all = await getBrowserJson<Listing[]>('https://www.atlassian.com/endpoint/careers/listings');
    return all
      .filter((l) => !hints?.country || (l.locations ?? []).some((loc) => mentionsCountry(loc, hints.country!)))
      .map((l): DiscoveredJob => {
        const location = (l.locations ?? []).join('; ');
        return {
          url: l.portalJobPost?.portalUrl ?? l.applyUrl ?? `https://www.atlassian.com/company/careers/details/${l.id}`,
          ats: 'atlassian',
          title: l.title,
          companyName: 'Atlassian',
          location: location || undefined,
          remote: /remote/i.test(location),
          descriptionText: [l.overview, l.responsibilities, l.qualifications]
            .map((h) => stripHtml(h ?? ''))
            .filter(Boolean)
            .join('\n\n'),
          // The feed only says when a posting was last edited, which is not when
          // it was posted, so no date rather than a wrong one.
        };
      });
  },
};
