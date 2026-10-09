import { postJson } from '../http.js';
import { remoteFromLabel, stripHtml } from '../text.js';
import type { Source } from '../types.js';

interface WorkableJob {
  title: string;
  shortcode: string;
  url?: string;
  description?: string;
  location?: { city?: string; country?: string; workplace?: string };
  published?: string;
}

export const workableSource: Source = {
  id: 'workable',
  handleHint: 'account slug, e.g. the "acme" in apply.workable.com/acme',

  async fetchJobs(handle) {
    const data = await postJson<{ results?: WorkableJob[] }>(
      `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(handle)}/jobs`,
      { query: '', location: [], department: [], worktype: [], remote: [] },
    );
    return (data.results ?? []).map((j) => {
      const loc = [j.location?.city, j.location?.country].filter(Boolean).join(', ');
      return {
        url: j.url ?? `https://apply.workable.com/${handle}/j/${j.shortcode}/`,
        ats: 'workable',
        title: j.title,
        companyName: handle,
        location: loc || undefined,
        remote: remoteFromLabel(j.location?.workplace, loc),
        descriptionText: stripHtml(j.description ?? ''),
        postedAt: j.published ? new Date(j.published) : undefined,
      };
    });
  },
};
