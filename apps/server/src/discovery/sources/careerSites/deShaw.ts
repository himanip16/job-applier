import { getText } from '../http.js';
import { looksRemote, stripHtml } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { dedupe, mentionsCountry } from './shared.js';

interface Job {
  data: {
    id: number;
    displayName: string;
    jobUrl: string;
    activeOnJobsListing?: boolean;
    jobDescription?: {
      websiteDescription?: string | null;
      responsibilities?: string | null;
      responsibilitiesHtml?: string | null;
      peopleWeAreLookingFor?: string[] | null;
      peopleWeAreLookingForHtml?: string | null;
    };
  };
  office?: { name: string }[];
}

/**
 * D. E. Shaw. The careers page is a Next.js page that ships every opening, with
 * its full description, in `__NEXT_DATA__` for its own hydration, so one fetch
 * reads the whole list.
 *
 * Handle: the careers host, "www.deshawindia.com" for the India office or
 * "www.deshaw.com" for the global site.
 */
export const deShawSource: Source = {
  id: 'deshaw',
  handleHint: 'careers host, e.g. "www.deshawindia.com"',

  async fetchJobs(handle, hints) {
    const host = handle.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const html = await getText(`https://${host}/careers`);
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('D. E. Shaw careers page changed shape: no __NEXT_DATA__ block');
    const props = (JSON.parse(m[1]!) as { props?: { pageProps?: { regularJobs?: Job[] } } }).props?.pageProps;
    if (!props?.regularJobs) throw new Error('D. E. Shaw careers page changed shape: no regularJobs list');

    return dedupe(
      props.regularJobs
        .filter((j) => j.data.activeOnJobsListing !== false)
        .map((j): DiscoveredJob => {
          const offices = (j.office ?? []).map((o) => o.name).filter(Boolean);
          // The India site names cities only; say which country they are in.
          const location = offices.length ? `${offices.join('; ')}${/deshawindia/.test(host) ? ', India' : ''}` : undefined;
          const d = j.data.jobDescription ?? {};
          return {
            url: `https://${host}/careers/${j.data.jobUrl.toLowerCase()}`,
            ats: 'deshaw',
            title: j.data.displayName.trim(),
            companyName: 'D. E. Shaw',
            location,
            remote: looksRemote(location ?? ''),
            descriptionText: [
              d.websiteDescription,
              d.responsibilitiesHtml ? stripHtml(d.responsibilitiesHtml) : d.responsibilities,
              d.peopleWeAreLookingForHtml ? stripHtml(d.peopleWeAreLookingForHtml) : (d.peopleWeAreLookingFor ?? []).join('\n'),
            ]
              .map((s) => (s ?? '').trim())
              .filter(Boolean)
              .join('\n\n'),
            // The listing carries no posting date.
          };
        })
        .filter((j) => !hints?.country || !j.location || mentionsCountry(j.location, hints.country)),
    );
  },
};
