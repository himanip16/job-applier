import { getJson } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { Source } from '../types.js';

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  content?: string;
  location?: { name?: string };
  /** The company's own display name. Greenhouse sends it; most boards fill it in. */
  company_name?: string;
}

export const greenhouseSource: Source = {
  id: 'greenhouse',
  handleHint: 'board slug, e.g. the "acme" in job-boards.greenhouse.io/acme',

  async fetchJobs(handle) {
    // `content=true` returns the full HTML description with the listing, so we
    // get everything in one request instead of N+1.
    const data = await getJson<{ jobs: GhJob[] }>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(handle)}/jobs?content=true`,
    );
    return (data.jobs ?? []).map((j) => {
      const loc = j.location?.name ?? '';
      const description = stripHtml(j.content ?? '');
      return {
        url: j.absolute_url,
        ats: 'greenhouse',
        title: j.title,
        // The board API carries the real name ("Mercury") alongside the slug
        // ("mercury"), and a triage queue full of slugs reads like a bug.
        companyName: j.company_name || handle,
        location: loc || undefined,
        remote: looksRemote(`${loc} ${j.title}`) || looksRemote(description.slice(0, 1200)),
        descriptionText: description,
        postedAt: j.updated_at ? new Date(j.updated_at) : undefined,
      };
    });
  },
};
