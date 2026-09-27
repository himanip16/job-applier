import { getJson } from '../http.js';
import { remoteFrom, stripHtml } from '../text.js';
import type { Source } from '../types.js';

interface AshbyJob {
  title: string;
  location?: string;
  isRemote?: boolean;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
}

export const ashbySource: Source = {
  id: 'ashby',
  handleHint: 'org slug, e.g. the "acme" in jobs.ashbyhq.com/acme',

  async fetchJobs(handle) {
    const data = await getJson<{ jobs: AshbyJob[] }>(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(handle)}`,
    );
    return (data.jobs ?? [])
      .filter((j) => j.jobUrl || j.applyUrl)
      .map((j) => ({
        url: (j.jobUrl ?? j.applyUrl)!,
        ats: 'ashby',
        title: j.title,
        companyName: handle,
        location: j.location,
        remote: remoteFrom(
          j.isRemote === true ? 'remote' : j.isRemote === false ? 'onsite' : 'unspecified',
          j.location ?? '',
        ),
        descriptionText: j.descriptionPlain ?? stripHtml(j.descriptionHtml ?? ''),
        postedAt: j.publishedAt ? new Date(j.publishedAt) : undefined,
      }));
  },
};
