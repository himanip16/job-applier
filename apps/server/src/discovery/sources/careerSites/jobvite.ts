import { getText } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { hydrate, mentionsCountry, queryOverlap, uniqueBy } from './shared.js';

interface Listing {
  id: string;
  title: string;
  location: string;
}

/** Most list pages read; Jobvite pages hold every opening on one or two. */
const MAX_LIST_PAGES = 5;

/**
 * Jobvite's hosted board, jobs.jobvite.com/<company>. Nutanix's own careers
 * site sits behind a bot wall; this is the board it is fed from.
 *
 * Plain server-rendered HTML, no API: a table of title and location, and a
 * detail page per posting. No server-side search, so country and role are
 * narrowed here before any detail page is read.
 */
export const jobviteSource: Source = {
  id: 'jobvite',
  handleHint: 'company slug, e.g. the "acme" in jobs.jobvite.com/acme',

  async fetchJobs(handle, hints) {
    const base = `https://jobs.jobvite.com/${encodeURIComponent(handle)}`;
    const all: Listing[] = [];
    for (let p = 0; p < MAX_LIST_PAGES; p++) {
      const html = await getText(`${base}/jobs${p ? `?p=${p}` : ''}`);
      const page = parseList(html, handle);
      const fresh = page.filter((l) => !all.some((a) => a.id === l.id));
      if (!fresh.length) break;
      all.push(...fresh);
    }
    if (!all.length) throw new Error(`No postings found at ${base}/jobs - is "${handle}" the right slug?`);

    const candidates = uniqueBy(all, (l) => l.id)
      .filter((l) => !hints?.country || mentionsCountry(l.location, hints.country))
      .sort((a, b) => queryOverlap(b.title, hints) - queryOverlap(a.title, hints));

    return hydrate(candidates, async (l): Promise<DiscoveredJob> => {
      const url = `${base}/job/${l.id}`;
      return {
        url,
        ats: 'jobvite',
        title: l.title,
        companyName: handle,
        location: l.location || undefined,
        remote: looksRemote(`${l.title} ${l.location}`),
        descriptionText: parseDescription(await getText(url)),
      };
    }, hints);
  },
};

/** Rows of the main job table. The "Featured Jobs" box above it repeats some; ids dedupe them. */
function parseList(html: string, handle: string): Listing[] {
  const at = html.indexOf('class="jv-job-list"');
  if (at < 0) return [];
  const table = html.slice(at);
  const out: Listing[] = [];
  const row = new RegExp(
    `<a href="/${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/job/([A-Za-z0-9]+)"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?class="jv-job-list-location">([\\s\\S]*?)</td>`,
    'gi',
  );
  for (const m of table.matchAll(row)) {
    out.push({ id: m[1]!, title: clean(m[2]!), location: clean(m[3]!) });
  }
  return out;
}

function parseDescription(html: string): string {
  const start = html.indexOf('<div class="jv-job-detail-description"');
  if (start < 0) return '';
  const end = html.indexOf('jv-job-detail-bottom-actions', start);
  return stripHtml(html.slice(start, end > start ? end : undefined));
}

const clean = (s: string) => stripHtml(s).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
