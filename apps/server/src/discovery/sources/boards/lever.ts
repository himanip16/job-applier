import { getJson } from '../http.js';
import { remoteFromLabel, stripHtml } from '../text.js';
import type { Source } from '../types.js';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  descriptionPlain?: string;
  description?: string;
  categories?: { location?: string; team?: string; commitment?: string };
  workplaceType?: string;
  lists?: { text: string; content: string }[];
}

export const leverSource: Source = {
  id: 'lever',
  handleHint: 'org slug, e.g. the "acme" in jobs.lever.co/acme',

  async fetchJobs(handle) {
    const data = await getJson<LeverPosting[]>(
      `https://api.lever.co/v0/postings/${encodeURIComponent(handle)}?mode=json`,
    );
    return (data ?? []).map((p) => {
      const extras = (p.lists ?? []).map((l) => `${l.text}\n${stripHtml(l.content)}`).join('\n\n');
      const loc = p.categories?.location ?? '';
      return {
        url: p.hostedUrl,
        ats: 'lever',
        title: p.text,
        companyName: handle,
        location: loc || undefined,
        remote: remoteFromLabel(p.workplaceType, `${loc} ${p.text}`),
        descriptionText: [p.descriptionPlain ?? stripHtml(p.description ?? ''), extras]
          .filter(Boolean)
          .join('\n\n'),
        postedAt: p.createdAt ? new Date(p.createdAt) : undefined,
      };
    });
  },
};
