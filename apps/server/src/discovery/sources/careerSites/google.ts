import { getText } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { dedupe, fromEpochSeconds, searchPaged } from './shared.js';

/** One posting as Google ships it: a positional array, not an object. */
type Row = unknown[];

/** The indices that matter in a row, found by reading a live page. */
const COL = { id: 0, title: 1, responsibilities: 3, qualifications: 4, locations: 9, about: 10, posted: 12, preferred: 19 };

/**
 * Google careers. There is no public API any more, but the results page ships
 * its data as a JSON blob (`AF_initDataCallback`, key `ds:1`) for its own
 * hydration, twenty postings a page with full descriptions.
 */
export const googleSource: Source = {
  id: 'google',
  handleHint: 'unused - Google careers',

  async fetchJobs(_handle, hints) {
    const rows = await searchPaged<Row>(
      hints,
      20,
      async (query, offset) => {
        const params = new URLSearchParams({ q: query, page: String(offset / 20 + 1) });
        if (hints?.country) params.set('location', hints.country.name);
        const html = await getText(`https://www.google.com/about/careers/applications/jobs/results?${params}`);
        const m = html.match(/AF_initDataCallback\(\{key: 'ds:1', hash: '\d+', data:([\s\S]*?), sideChannel: \{\}\}\);<\/script>/);
        if (!m) throw new Error('Google careers page changed shape: no ds:1 data block');
        return { items: ((JSON.parse(m[1]!) as Row[][])[0] ?? []) as Row[] };
      },
      300,
    );
    return dedupe(rows.map(toJob));
  },
};

function toJob(r: Row): DiscoveredJob {
  // Text fields are `[null, "<html>"]` pairs.
  const text = (col: number) => {
    const v = r[col] as [unknown, string] | null;
    return Array.isArray(v) && typeof v[1] === 'string' ? stripHtml(v[1]) : '';
  };
  const location = ((r[COL.locations] as [string][] | null) ?? []).map((l) => l[0]).filter(Boolean).join('; ');
  return {
    url: `https://www.google.com/about/careers/applications/jobs/results/${String(r[COL.id])}`,
    ats: 'google',
    title: String(r[COL.title]),
    companyName: 'Google',
    location: location || undefined,
    remote: looksRemote(location),
    descriptionText: [COL.about, COL.responsibilities, COL.preferred, COL.qualifications].map(text).filter(Boolean).join('\n\n'),
    postedAt: fromEpochSeconds((r[COL.posted] as [number] | null)?.[0]),
  };
}
