import { getText } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { hydrate, queryOverlap, searchPaged, uniqueBy } from './shared.js';

interface Row {
  path: string;
  title: string;
  location: string;
}

const decode = (s: string) => stripHtml(s).replace(/\s+/g, ' ').trim();

/**
 * SAP SuccessFactors career sites ("Recruiting Marketing"), which Nomura and
 * many banks run. The search page is server-rendered HTML that takes a text
 * query and a location, so the listing is read from its result table and each
 * posting's description from its own page.
 *
 * Handle: the careers host, e.g. "careers.nomura.com".
 */
export const successFactorsSource: Source = {
  id: 'successfactors',
  handleHint: 'careers host, e.g. "careers.nomura.com"',

  async fetchJobs(handle, hints) {
    const origin = `https://${handle.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`;
    // Sites set their own page size (Nomura's is 100). One page that large
    // already exceeds what a run reads, and a smaller one ends paging early.
    const pageSize = 100;
    const rows = await searchPaged<Row>(hints, pageSize, async (query, offset) => {
      const params = new URLSearchParams({ q: query, startrow: String(offset) });
      if (hints?.country) params.set('locationsearch', hints.country.name);
      const html = await getText(`${origin}/search/?${params}`);
      const items = [...html.matchAll(/<tr class="data-row">([\s\S]*?)<\/tr>/g)].flatMap(([, row]) => {
        const link = row!.match(/<a href="([^"]+)" class="jobTitle-link"[^>]*>([\s\S]*?)<\/a>/);
        if (!link) return [];
        return [{
          path: link[1]!,
          title: decode(link[2]!),
          location: decode(row!.match(/<span class="jobLocation">([\s\S]*?)<\/span>/)?.[1] ?? ''),
        }];
      });
      const total = html.match(/Results <b>[^<]*<\/b> of <b>(\d+)<\/b>/)?.[1];
      return { items, total: total ? Number(total) : undefined };
    });

    // Only so many detail pages are read: the closest titles first.
    const ranked = uniqueBy(rows, (r) => r.path).sort((a, b) => queryOverlap(b.title, hints) - queryOverlap(a.title, hints));
    return hydrate(ranked, async (r): Promise<DiscoveredJob> => {
      const url = new URL(r.path, origin).toString();
      const html = await getText(url);
      const description = html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/)?.[1] ?? html.match(/<span class="jobdescription">([\s\S]*?)<\/span>/)?.[1] ?? '';
      const posted = html.match(/itemprop="datePosted" content="([^"]+)"/)?.[1];
      const postedAt = posted ? new Date(posted) : undefined;
      return {
        url,
        ats: 'successfactors',
        title: r.title,
        companyName: html.match(/itemprop="hiringOrganization"[^>]*content="([^"]+)"/)?.[1] ?? '',
        location: r.location || undefined,
        remote: looksRemote(r.location),
        descriptionText: stripHtml(description),
        postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : undefined,
      };
    }, hints);
  },
};
