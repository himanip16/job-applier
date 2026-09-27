import { getJson } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { hydrate, mentionsCountry, orElse, queryOverlap } from './shared.js';

interface Listing {
  uuid: string;
  name: string;
  url: string;
  workLocation?: { label?: string };
}

/** Rippling's own ATS board API. Handle: the board slug, e.g. "rippling". */
export const ripplingSource: Source = {
  id: 'rippling',
  handleHint: 'board slug, e.g. the "acme" in ats.rippling.com/acme',

  async fetchJobs(handle, hints) {
    const base = `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(handle)}/jobs`;
    const all = await getJson<Listing[]>(base);

    // No server-side search, so narrow by country here, and read the likeliest
    // title matches first since only so many details get read at all.
    const candidates = all
      .filter((l) => !hints?.country || mentionsCountry(l.workLocation?.label ?? '', hints.country))
      .sort((a, b) => queryOverlap(b.name, hints) - queryOverlap(a.name, hints));

    return hydrate(candidates, async (l): Promise<DiscoveredJob> => {
      const location = l.workLocation?.label ?? '';
      const detail = await orElse(getJson<{ description?: Record<string, string> }>(`${base}/${l.uuid}`), {});
      return {
        url: l.url,
        ats: 'rippling',
        title: l.name,
        companyName: handle,
        location: location || undefined,
        remote: looksRemote(location),
        descriptionText: Object.values(detail.description ?? {}).map(stripHtml).join('\n\n'),
      };
    }, hints);
  },
};
