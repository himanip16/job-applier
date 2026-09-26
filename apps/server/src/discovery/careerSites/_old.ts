/**
 * Crawlers for the companies that do not use Greenhouse, Lever or Ashby.
 *
 * Most of the best-paying employers run their own careers site, and a generic
 * page crawl does badly on them: they are client-rendered, paginated behind
 * JavaScript, and list thousands of roles worldwide. Almost all of them are
 * backed by a JSON endpoint the page itself calls, though, and reading that is
 * the same trade the board APIs make - structured data, real locations, full
 * descriptions, no DOM parsing.
 *
 * Three of these are platforms many companies share (Workday, SmartRecruiters,
 * Eightfold), so their handle says which tenant. The rest are one company's
 * bespoke site and ignore the handle.
 *
 * Every source searches server-side with the caller's role titles and country
 * where the site supports it, and caps how many postings it hydrates, because
 * "read all 1,700 NVIDIA openings to keep eight" is not a crawl, it is a load
 * test on someone else's website.
 */
import type { Country } from '@ja/shared';
import {
  getJson,
  looksRemote,
  remoteFrom,
  stripHtml,
  UA,
  type DiscoveredJob,
  type FetchHints,
  type Source,
} from './sources.js';

/** Most postings any one site contributes to a single run. */
const MAX_PER_SITE = 60;
/** Most detail pages fetched per site, for sources whose list has no description. */
const MAX_DETAILS = 30;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The searches to run: each role title, or one empty search for "everything". */
const queriesFrom = (hints?: FetchHints): string[] => {
  const qs = (hints?.queries ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 3);
  return qs.length ? qs : [''];
};

async function getText(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': BROWSER_UA, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res.text();
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA, ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

/** Keep the first posting per URL; several searches return the same role. */
function dedupe(jobs: DiscoveredJob[]): DiscoveredJob[] {
  const seen = new Set<string>();
  return jobs.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}

/** Run `fn` over `items` one at a time with a pause, stopping at `limit`. */
async function politely<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const [i, item] of items.slice(0, limit).entries()) {
    if (i > 0) await sleep(150);
    out.push(await fn(item));
  }
  return out;
}

const fromEpochSeconds = (s: number | undefined): Date | undefined =>
  typeof s === 'number' && s > 0 ? new Date(s * 1000) : undefined;

// ------------------------------------------------------------------ workday ---

interface WdListing {
  title: string;
  externalPath: string;
  locationsText?: string;
}
interface WdDetail {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    startDate?: string;
    externalUrl?: string;
    remoteType?: string;
    country?: { descriptor?: string };
  };
}

/**
 * Workday's candidate-experience API, the one every myworkdayjobs.com page calls.
 *
 * Handle: `<tenant>.<wdN>/<site>`, e.g. `nvidia.wd5/NVIDIAExternalCareerSite` for
 * https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite. The listing has
 * no description and often says "3 Locations", so each kept posting is read in
 * full - that is what the detail cap is for.
 */
export const workdaySource: Source = {
  id: 'workday',
  handleHint: 'tenant.wdN/site, e.g. "nvidia.wd5/NVIDIAExternalCareerSite"',

  async fetchJobs(handle, hints) {
    const m = handle.match(/^([a-z0-9-]+)\.(wd\d+)\/([A-Za-z0-9_-]+)$/i);
    if (!m) throw new Error(`Workday handle should look like "tenant.wd5/Site", got "${handle}"`);
    const [, tenant, wd, site] = m;
    const base = `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;

    const listings: WdListing[] = [];
    for (const q of queriesFrom(hints)) {
      // Workday's full-text search covers location too, so naming the country
      // narrows a worldwide board to it without needing its facet ids.
      const searchText = [q, hints?.country?.name].filter(Boolean).join(' ');
      for (let offset = 0; offset < MAX_PER_SITE; offset += 20) {
        const page = await postJson<{ jobPostings?: WdListing[]; total?: number }>(`${base}/jobs`, {
          appliedFacets: {},
          limit: 20,
          offset,
          searchText,
        });
        listings.push(...(page.jobPostings ?? []));
        if (!page.jobPostings?.length || offset + 20 >= (page.total ?? 0)) break;
        await sleep(150);
      }
    }

    const unique = [...new Map(listings.map((l) => [l.externalPath, l])).values()];
    const jobs = await politely(unique, MAX_DETAILS, async (l): Promise<DiscoveredJob | null> => {
      try {
        const d = (await getJson<WdDetail>(`${base}${l.externalPath}`)).jobPostingInfo ?? {};
        const location = [d.location, ...(d.additionalLocations ?? [])].filter(Boolean).join('; ');
        const description = stripHtml(d.jobDescription ?? '');
        const remoteType = (d.remoteType ?? '').toLowerCase();
        return {
          url: d.externalUrl ?? `https://${tenant}.${wd}.myworkdayjobs.com/${site}${l.externalPath}`,
          ats: 'workday',
          title: d.title ?? l.title,
          companyName: tenant!,
          location: location || l.locationsText,
          remote: remoteFrom(
            remoteType.includes('remote') ? 'remote' : remoteType.includes('hybrid') ? 'hybrid' : 'unspecified',
            `${location} ${description.slice(0, 1200)}`,
          ),
          descriptionText: description,
          postedAt: d.startDate ? new Date(d.startDate) : undefined,
        };
      } catch {
        return null;
      }
    });
    return dedupe(jobs.filter((j): j is DiscoveredJob => j !== null));
  },
};

// ----------------------------------------------------------- smartrecruiters ---

interface SrPosting {
  id: string;
  name: string;
  ref: string;
  releasedDate?: string;
  location?: { fullLocation?: string; city?: string; remote?: boolean; hybrid?: boolean };
  company?: { name?: string };
}
interface SrDetail {
  postingUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

/** SmartRecruiters' public postings API. Handle: the company id, e.g. "ServiceNow". */
export const smartRecruitersSource: Source = {
  id: 'smartrecruiters',
  handleHint: 'company id, e.g. the "ServiceNow" in jobs.smartrecruiters.com/ServiceNow',

  async fetchJobs(handle, hints) {
    const postings: SrPosting[] = [];
    for (const q of queriesFrom(hints)) {
      const params = new URLSearchParams({ limit: '100' });
      if (q) params.set('q', q);
      if (hints?.country) params.set('country', hints.country.code.toLowerCase());
      const page = await getJson<{ content?: SrPosting[] }>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(handle)}/postings?${params}`,
      );
      postings.push(...(page.content ?? []));
    }
    const unique = [...new Map(postings.map((p) => [p.id, p])).values()];

    const jobs = await politely(unique, MAX_DETAILS, async (p): Promise<DiscoveredJob | null> => {
      try {
        const d = await getJson<SrDetail>(p.ref);
        const description = Object.values(d.jobAd?.sections ?? {})
          .map((s) => [s.title, stripHtml(s.text ?? '')].filter(Boolean).join('\n'))
          .join('\n\n');
        const loc = p.location?.fullLocation?.replace(/,\s*,/g, ',') ?? p.location?.city;
        return {
          url: d.postingUrl ?? `https://jobs.smartrecruiters.com/${handle}/${p.id}`,
          ats: 'smartrecruiters',
          title: p.name,
          companyName: p.company?.name || handle,
          location: loc || undefined,
          remote: remoteFrom(
            p.location?.remote ? 'remote' : p.location?.hybrid ? 'hybrid' : p.location ? 'onsite' : 'unspecified',
            loc ?? '',
          ),
          descriptionText: description,
          postedAt: p.releasedDate ? new Date(p.releasedDate) : undefined,
        };
      } catch {
        return null;
      }
    });
    return dedupe(jobs.filter((j): j is DiscoveredJob => j !== null));
  },
};

// ---------------------------------------------------------------- eightfold ---

interface EfPosition {
  id: number;
  name: string;
  location?: string;
  locations?: string[];
  t_create?: number;
  postedTs?: number;
  job_description?: string;
  canonicalPositionUrl?: string;
  positionUrl?: string;
  work_location_option?: string;
  workLocationOption?: string;
}

/**
 * Eightfold, which runs Netflix's, Millennium's and Microsoft's careers sites.
 *
 * Handle: `<host>|<domain>`, e.g. `explore.jobs.netflix.net|netflix.com`. It has
 * two generations of API and each tenant has only one switched on: the older
 * `apply/v2` returns descriptions inline, the newer `pcsx` (Microsoft) needs a
 * detail call per posting. Both are tried, old first.
 */
export const eightfoldSource: Source = {
  id: 'eightfold',
  handleHint: 'host|domain, e.g. "explore.jobs.netflix.net|netflix.com"',

  async fetchJobs(handle, hints) {
    const [host, domain] = handle.split('|');
    if (!host || !domain) throw new Error(`Eightfold handle should look like "host|domain", got "${handle}"`);

    try {
      return await eightfoldV2(host, domain, hints);
    } catch (err) {
      if (!/not authorized|pcsx|40[134]/i.test((err as Error).message)) throw err;
    }
    return eightfoldPcsx(host, domain, hints);
  },
};

async function eightfoldV2(host: string, domain: string, hints?: FetchHints): Promise<DiscoveredJob[]> {
  const positions: EfPosition[] = [];
  for (const q of queriesFrom(hints)) {
    for (let start = 0; start < MAX_PER_SITE; start += 10) {
      const params = new URLSearchParams({ domain, query: q, start: String(start), num: '10' });
      if (hints?.country) params.set('location', hints.country.name);
      const page = await getJson<{ positions?: EfPosition[]; count?: number; message?: string }>(
        `https://${host}/api/apply/v2/jobs?${params}`,
      );
      if (!page.positions) throw new Error(page.message || 'not authorized');
      positions.push(...page.positions);
      if (!page.positions.length || start + 10 >= (page.count ?? 0)) break;
      await sleep(150);
    }
  }
  // The list carries only a stub of the description; the detail has all of it.
  const unique = [...new Map(positions.map((p) => [p.id, p])).values()];
  const jobs = await politely(unique, MAX_DETAILS, async (p) => {
    let full = p;
    try {
      full = await getJson<EfPosition>(`https://${host}/api/apply/v2/jobs/${p.id}?domain=${domain}`);
    } catch {
      /* keep the stub */
    }
    return eightfoldJob(host, domain, full);
  });
  return dedupe(jobs);
}

async function eightfoldPcsx(host: string, domain: string, hints?: FetchHints): Promise<DiscoveredJob[]> {
  const positions: EfPosition[] = [];
  for (const q of queriesFrom(hints)) {
    for (let start = 0; start < MAX_PER_SITE; start += 10) {
      const params = new URLSearchParams({ domain, query: q, start: String(start) });
      if (hints?.country) params.set('location', hints.country.name);
      const page = await getJson<{ data?: { positions?: EfPosition[]; count?: number } }>(
        `https://${host}/api/pcsx/search?${params}`,
      );
      const batch = page.data?.positions ?? [];
      positions.push(...batch);
      if (!batch.length || start + batch.length >= (page.data?.count ?? 0)) break;
      await sleep(150);
    }
  }
  const unique = [...new Map(positions.map((p) => [p.id, p])).values()];
  const jobs = await politely(unique, MAX_DETAILS, async (p) => {
    try {
      const d = await getJson<{ data?: EfPosition & { jobDescription?: string } }>(
        `https://${host}/api/pcsx/position_details?position_id=${p.id}&domain=${domain}&hl=en`,
      );
      return eightfoldJob(host, domain, { ...p, job_description: d.data?.jobDescription });
    } catch {
      return eightfoldJob(host, domain, p);
    }
  });
  return dedupe(jobs);
}

function eightfoldJob(host: string, domain: string, p: EfPosition): DiscoveredJob {
  const location = (p.locations?.length ? p.locations : [p.location]).filter(Boolean).join('; ');
  const option = (p.work_location_option ?? p.workLocationOption ?? '').toLowerCase();
  const path = p.canonicalPositionUrl ?? p.positionUrl ?? `/careers/job/${p.id}`;
  const description = stripHtml(p.job_description ?? '');
  return {
    url: path.startsWith('http') ? path : `https://${host}${path}`,
    ats: 'eightfold',
    title: p.name,
    companyName: domain.split('.')[0]!,
    location: location || undefined,
    remote: remoteFrom(
      option.includes('remote') ? 'remote' : option.includes('hybrid') ? 'hybrid' : option ? 'onsite' : 'unspecified',
      location,
    ),
    descriptionText: description,
    postedAt: fromEpochSeconds(p.t_create ?? p.postedTs),
  };
}

// ------------------------------------------------------------------- google ---

/**
 * Google careers. There is no public API any more, but the results page ships
 * its data as a JSON blob (`AF_initDataCallback`, key `ds:1`) for its own
 * hydration, twenty postings a page with full descriptions.
 */
export const googleSource: Source = {
  id: 'google',
  handleHint: 'unused - Google careers',

  async fetchJobs(_handle, hints) {
    const jobs: DiscoveredJob[] = [];
    for (const q of queriesFrom(hints)) {
      for (let page = 1; page <= Math.ceil(MAX_PER_SITE / 20); page++) {
        const params = new URLSearchParams({ q, page: String(page) });
        if (hints?.country) params.set('location', hints.country.name);
        const html = await getText(`https://www.google.com/about/careers/applications/jobs/results?${params}`);
        const m = html.match(/AF_initDataCallback\(\{key: 'ds:1', hash: '\d+', data:([\s\S]*?), sideChannel: \{\}\}\);<\/script>/);
        if (!m) throw new Error('Google careers page changed shape: no ds:1 data block');
        const rows = (JSON.parse(m[1]!) as unknown[][])[0] as unknown[][] | null;
        if (!rows?.length) break;
        for (const r of rows) {
          const id = String(r[0]);
          const text = (i: number) => {
            const v = r[i] as [unknown, string] | null;
            return Array.isArray(v) && typeof v[1] === 'string' ? stripHtml(v[1]) : '';
          };
          const locations = ((r[9] as [string][] | null) ?? []).map((l) => l[0]).filter(Boolean);
          const location = locations.join('; ');
          jobs.push({
            url: `https://www.google.com/about/careers/applications/jobs/results/${id}`,
            ats: 'google',
            title: String(r[1]),
            companyName: 'Google',
            location: location || undefined,
            remote: looksRemote(location),
            descriptionText: [text(10), text(3), text(19), text(4)].filter(Boolean).join('\n\n'),
            postedAt: fromEpochSeconds((r[12] as [number] | null)?.[0]),
          });
        }
        if (rows.length < 20) break;
        await sleep(300);
      }
    }
    return dedupe(jobs);
  },
};

// -------------------------------------------------------------------- apple ---

/** Apple's own location slugs, which are not ISO codes. */
const APPLE_LOCATIONS: Record<string, string> = {
  IN: 'india-INDC',
  US: 'united-states-USA',
  GB: 'united-kingdom-GBR',
  IE: 'ireland-IRL',
  DE: 'germany-DEU',
  CA: 'canada-CAN',
  NL: 'netherlands-NLD',
  FR: 'france-FRA',
  SG: 'singapore-SGP',
};

interface AppleResult {
  positionId: string;
  postingTitle: string;
  transformedPostingTitle: string;
  jobSummary?: string;
  postDateInGMT?: string;
  homeOffice?: boolean;
  locations?: { name?: string; city?: string; countryName?: string }[];
}

/** Apple careers: the search page embeds its results as router hydration data. */
export const appleSource: Source = {
  id: 'apple',
  handleHint: 'unused - Apple careers',

  async fetchJobs(_handle, hints) {
    const jobs: DiscoveredJob[] = [];
    const loc = hints?.country ? APPLE_LOCATIONS[hints.country.code] : undefined;
    for (const q of queriesFrom(hints)) {
      for (let page = 1; page <= Math.ceil(MAX_PER_SITE / 20); page++) {
        const params = new URLSearchParams({ search: q, page: String(page) });
        if (loc) params.set('location', loc);
        const html = await getText(`https://jobs.apple.com/en-us/search?${params}`);
        const m = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/);
        if (!m) throw new Error('Apple careers page changed shape: no hydration data');
        const data = JSON.parse(JSON.parse(`"${m[1]}"`) as string) as {
          loaderData?: { search?: { searchResults?: AppleResult[] } };
        };
        const results = data.loaderData?.search?.searchResults ?? [];
        for (const r of results) {
          const location = (r.locations ?? []).map((l) => [l.city, l.countryName].filter(Boolean).join(', ') || l.name).join('; ');
          jobs.push({
            url: `https://jobs.apple.com/en-us/details/${r.positionId}/${r.transformedPostingTitle}`,
            ats: 'apple',
            title: r.postingTitle,
            companyName: 'Apple',
            location: location || undefined,
            remote: r.homeOffice === true,
            descriptionText: stripHtml(r.jobSummary ?? ''),
            postedAt: r.postDateInGMT ? new Date(r.postDateInGMT) : undefined,
          });
        }
        if (results.length < 20) break;
        await sleep(300);
      }
    }
    return dedupe(jobs);
  },
};

// ----------------------------------------------------------------- linkedin ---

/**
 * LinkedIn's own openings, from the logged-out jobs pages.
 *
 * Handle: the numeric company id LinkedIn filters on (`f_C`), 1337 for LinkedIn
 * itself. No login, no cookies - this is the public job search anyone sees.
 */
export const linkedinCompanySource: Source = {
  id: 'linkedin-company',
  handleHint: 'numeric LinkedIn company id, e.g. 1337',

  async fetchJobs(handle, hints) {
    const cards: { id: string; title: string; location: string; url: string; posted?: string }[] = [];
    for (const q of queriesFrom(hints)) {
      for (let start = 0; start < MAX_PER_SITE; start += 25) {
        const params = new URLSearchParams({ keywords: q, f_C: handle, start: String(start) });
        if (hints?.country) params.set('location', hints.country.name);
        const html = await getText(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`);
        const found = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
        for (const li of found) {
          const id = li.match(/urn:li:jobPosting:(\d+)/)?.[1];
          const title = li.match(/base-search-card__title">([\s\S]*?)<\/h3>/)?.[1];
          if (!id || !title) continue;
          cards.push({
            id,
            title: stripHtml(title),
            location: stripHtml(li.match(/job-search-card__location">([\s\S]*?)<\/span>/)?.[1] ?? ''),
            url: `https://www.linkedin.com/jobs/view/${id}`,
            posted: li.match(/datetime="([\d-]+)"/)?.[1],
          });
        }
        if (found.length < 25) break;
        await sleep(400);
      }
    }
    const unique = [...new Map(cards.map((c) => [c.id, c])).values()];
    const jobs = await politely(unique, MAX_DETAILS, async (c): Promise<DiscoveredJob> => {
      let description = '';
      try {
        const html = await getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${c.id}`);
        const body = html.match(/class="description__text[^"]*"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
        description = stripHtml(body).replace(/\s*Show (more|less)\s*/g, ' ').trim();
      } catch {
        /* the card alone is still a lead */
      }
      return {
        url: c.url,
        ats: 'linkedin',
        title: c.title,
        companyName: 'LinkedIn',
        location: c.location || undefined,
        remote: looksRemote(c.location),
        descriptionText: description,
        postedAt: c.posted ? new Date(c.posted) : undefined,
      };
    });
    return dedupe(jobs);
  },
};

// --------------------------------------------------------------------- jibe ---

interface JibeJob {
  data: {
    slug: string;
    title: string;
    description?: string;
    full_location?: string;
    city?: string;
    country?: string;
    location_type?: string;
    posted_date?: string;
    apply_url?: string;
  };
}

/**
 * Jibe (iCIMS' candidate site), which Booking.com runs on.
 * Handle: the host, e.g. "jobs.booking.com".
 */
export const jibeSource: Source = {
  id: 'jibe',
  handleHint: 'careers host, e.g. "jobs.booking.com"',

  async fetchJobs(handle, hints) {
    const jobs: DiscoveredJob[] = [];
    for (const q of queriesFrom(hints)) {
      for (let page = 1; page <= Math.ceil(MAX_PER_SITE / 50); page++) {
        const params = new URLSearchParams({ keywords: q, page: String(page), limit: '50' });
        if (hints?.country) params.set('location', hints.country.name);
        const res = await getJson<{ jobs?: JibeJob[]; totalCount?: number }>(`https://${handle}/api/jobs?${params}`);
        for (const { data: d } of res.jobs ?? []) {
          const location = d.full_location ?? [d.city, d.country].filter(Boolean).join(', ');
          const type = (d.location_type ?? '').toLowerCase();
          jobs.push({
            url: `https://${handle}/${handle.split('.')[1] ?? 'jobs'}/jobs/${d.slug}`,
            ats: 'jibe',
            title: d.title,
            companyName: handle.split('.')[1] ?? handle,
            location: location || undefined,
            remote: remoteFrom(type.includes('remote') ? 'remote' : type.includes('hybrid') ? 'hybrid' : 'unspecified', location),
            descriptionText: stripHtml(d.description ?? ''),
            postedAt: d.posted_date ? new Date(d.posted_date) : undefined,
          });
        }
        if ((res.jobs?.length ?? 0) < 50) break;
        await sleep(200);
      }
    }
    return dedupe(jobs);
  },
};

// ----------------------------------------------------------------- rippling ---

interface RipplingListing {
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
    const all = await getJson<RipplingListing[]>(base);
    // No server-side search, so narrow by country before reading details.
    const narrowed = hints?.country
      ? all.filter((l) => mentionsCountry(l.workLocation?.label ?? '', hints.country!))
      : all;
    // Read the likeliest matches first, since only MAX_DETAILS get read at all.
    const ranked = [...narrowed].sort((x, y) => queryOverlap(y.name, hints) - queryOverlap(x.name, hints));
    const jobs = await politely(ranked, MAX_DETAILS, async (l): Promise<DiscoveredJob> => {
      let description = '';
      try {
        const d = await getJson<{ description?: Record<string, string> }>(`${base}/${l.uuid}`);
        description = Object.values(d.description ?? {}).map(stripHtml).join('\n\n');
      } catch {
        /* keep the listing */
      }
      const location = l.workLocation?.label ?? '';
      return {
        url: l.url,
        ats: 'rippling',
        title: l.name,
        companyName: handle,
        location: location || undefined,
        remote: looksRemote(location),
        descriptionText: description,
      };
    });
    return dedupe(jobs);
  },
};

// ---------------------------------------------------------------- atlassian ---

interface AtlassianListing {
  id: string | number;
  title: string;
  locations?: string[];
  overview?: string;
  responsibilities?: string;
  qualifications?: string;
  applyUrl?: string;
  portalJobPost?: { portalUrl?: string; updatedDate?: string };
}

/** Atlassian: one JSON document with every opening and its full text. */
export const atlassianSource: Source = {
  id: 'atlassian',
  handleHint: 'unused - Atlassian careers',

  async fetchJobs(_handle, hints) {
    const res = await fetch('https://www.atlassian.com/endpoint/careers/listings', {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from atlassian.com`);
    const all = (await res.json()) as AtlassianListing[];
    return all
      .filter((l) => !hints?.country || (l.locations ?? []).some((loc) => mentionsCountry(loc, hints.country!)))
      .map((l) => {
        const location = (l.locations ?? []).join('; ');
        return {
          url: l.portalJobPost?.portalUrl ?? l.applyUrl ?? `https://www.atlassian.com/company/careers/details/${l.id}`,
          ats: 'atlassian',
          title: l.title,
          companyName: 'Atlassian',
          location: location || undefined,
          remote: /remote/i.test(location),
          descriptionText: [l.overview, l.responsibilities, l.qualifications].map((h) => stripHtml(h ?? '')).filter(Boolean).join('\n\n'),
          postedAt: l.portalJobPost?.updatedDate ? new Date(l.portalJobPost.updatedDate) : undefined,
        };
      });
  },
};

// ------------------------------------------------------------------ radancy ---

/**
 * Radancy (TalentBrew) sites, which Intuit runs on. The search endpoint returns
 * a rendered HTML fragment rather than JSON; each posting's page is then read
 * for its description. Handle: the host, e.g. "jobs.intuit.com".
 */
export const radancySource: Source = {
  id: 'radancy',
  handleHint: 'careers host, e.g. "jobs.intuit.com"',

  async fetchJobs(handle, hints) {
    const cards: { path: string; title: string; location: string }[] = [];
    for (const q of queriesFrom(hints)) {
      for (let page = 1; page <= Math.ceil(MAX_PER_SITE / 25); page++) {
        const params = new URLSearchParams({
          CurrentPage: String(page),
          RecordsPerPage: '25',
          Keywords: q,
          Location: hints?.country?.name ?? '',
          SearchResultsModuleName: 'Search Results',
          SearchFiltersModuleName: 'Search Filters',
          SortCriteria: '0',
          SortDirection: '0',
          SearchType: '1',
        });
        const res = await fetch(`https://${handle}/search-jobs/results?${params}`, {
          headers: { 'user-agent': BROWSER_UA, 'x-requested-with': 'XMLHttpRequest', accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${handle}`);
        const html = ((await res.json()) as { results?: string }).results ?? '';
        const found = [...html.matchAll(/<a href="(\/job\/[^"]+)"[^>]*data-title="([^"]*)"[\s\S]*?(?:class="job-location">([^<]*)<)?[\s\S]*?<\/a>/g)];
        for (const m of found) {
          // "Multiple Locations" says nothing; the city is in the URL path.
          const cityFromPath = m[1]!.split('/')[2]?.replace(/-/g, ' ') ?? '';
          const loc = (m[3] ?? '').trim();
          cards.push({ path: m[1]!, title: stripHtml(m[2]!), location: !loc || /multiple/i.test(loc) ? cityFromPath : loc });
        }
        if (found.length < 25) break;
        await sleep(300);
      }
    }
    const unique = [...new Map(cards.map((c) => [c.path, c])).values()];
    const jobs = await politely(unique, MAX_DETAILS, async (c): Promise<DiscoveredJob> => {
      let description = '';
      try {
        const html = await getText(`https://${handle}${c.path}`);
        // The posting is the job-description section; everything after it is
        // "similar jobs" and site chrome, which would drown the scorer.
        const body = html.match(/<section[^>]*class="job-description[\s\S]*?<\/section>/)?.[0] ?? '';
        description = stripHtml(body);
      } catch {
        /* keep the card */
      }
      return {
        url: `https://${handle}${c.path}`,
        ats: 'radancy',
        title: c.title,
        companyName: handle.split('.')[1] ?? handle,
        location: c.location || undefined,
        remote: looksRemote(c.location),
        descriptionText: description,
      };
    });
    return dedupe(jobs);
  },
};

// -------------------------------------------------------------------- utils ---

/** How many words of the searched role titles a posting title shares. */
function queryOverlap(title: string, hints?: FetchHints): number {
  const words = new Set(title.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2));
  return queriesFrom(hints)
    .flatMap((q) => q.toLowerCase().split(/[^a-z0-9+#]+/))
    .filter((w) => w.length > 2 && words.has(w)).length;
}

function mentionsCountry(text: string, country: Country): boolean {
  const t = text.toLowerCase();
  return [country.name.toLowerCase(), ...country.aliases].some((w) =>
    new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(t),
  );
}


export const CAREER_SITE_SOURCES: Source[] = [
  workdaySource,
  smartRecruitersSource,
  eightfoldSource,
  googleSource,
  appleSource,
  linkedinCompanySource,
  jibeSource,
  ripplingSource,
  atlassianSource,
  radancySource,
];
