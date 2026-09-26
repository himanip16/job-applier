import { getText } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { hydrate, orElse, searchPaged, toDate, uniqueBy } from './shared.js';

interface Card {
  id: string;
  title: string;
  location: string;
  posted?: string;
}

const GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api';

/**
 * A company's openings, from LinkedIn's logged-out jobs pages.
 *
 * Handle: the numeric company id LinkedIn filters on (`f_C`), 1337 for LinkedIn
 * itself. No login, no cookies - this is the public job search anyone sees.
 */
export const linkedinCompanySource: Source = {
  id: 'linkedin-company',
  handleHint: 'numeric LinkedIn company id, e.g. 1337',

  async fetchJobs(handle, hints) {
    const cards = await searchPaged<Card>(
      hints,
      25,
      async (query, offset) => {
        const params = new URLSearchParams({ keywords: query, f_C: handle, start: String(offset) });
        if (hints?.country) params.set('location', hints.country.name);
        return { items: parseCards(await getText(`${GUEST}/seeMoreJobPostings/search?${params}`)) };
      },
      400,
    );

    return hydrate(uniqueBy(cards, (c) => c.id), async (c): Promise<DiscoveredJob> => ({
      url: `https://www.linkedin.com/jobs/view/${c.id}`,
      ats: 'linkedin',
      title: c.title,
      companyName: 'LinkedIn',
      location: c.location || undefined,
      remote: looksRemote(c.location),
      // The card alone is still a lead if the description will not load.
      descriptionText: await orElse(readDescription(c.id), ''),
      postedAt: toDate(c.posted),
    }));
  },
};

function parseCards(html: string): Card[] {
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].flatMap(([, li = '']) => {
    const id = li.match(/urn:li:jobPosting:(\d+)/)?.[1];
    const title = li.match(/base-search-card__title">([\s\S]*?)<\/h3>/)?.[1];
    if (!id || !title) return [];
    return [{
      id,
      title: stripHtml(title),
      location: stripHtml(li.match(/job-search-card__location">([\s\S]*?)<\/span>/)?.[1] ?? ''),
      posted: li.match(/datetime="([\d-]+)"/)?.[1],
    }];
  });
}

async function readDescription(id: string): Promise<string> {
  const html = await getText(`${GUEST}/jobPosting/${id}`);
  const body = html.match(/class="description__text[^"]*"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
  return stripHtml(body).replace(/\s*Show (more|less)\s*/g, ' ').trim();
}
