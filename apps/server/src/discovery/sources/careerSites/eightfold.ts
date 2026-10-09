import { getJson } from '../http.js';
import { remoteFromLabel, stripHtml } from '../text.js';
import type { DiscoveredJob, FetchHints, Source } from '../types.js';
import { fromEpochSeconds, hydrate, orElse, searchPaged, uniqueBy } from './shared.js';

interface Position {
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
 * One generation of Eightfold's API: how to search, and how to read one
 * position's full description. Each tenant has exactly one switched on.
 */
interface EightfoldApi {
  search(host: string, domain: string, query: string, offset: number, hints?: FetchHints): Promise<{ items: Position[]; total?: number }>;
  description(host: string, domain: string, p: Position): Promise<string | undefined>;
}

/** The older API (Netflix, Millennium): positions and descriptions under apply/v2. */
const applyV2: EightfoldApi = {
  async search(host, domain, query, offset, hints) {
    const params = new URLSearchParams({ domain, query, start: String(offset), num: '10' });
    if (hints?.country) params.set('location', hints.country.name);
    const page = await getJson<{ positions?: Position[]; count?: number; message?: string }>(
      `https://${host}/api/apply/v2/jobs?${params}`,
    );
    if (!page.positions) throw new Error(page.message || 'not authorized');
    return { items: page.positions, total: page.count };
  },
  async description(host, domain, p) {
    return (await getJson<Position>(`https://${host}/api/apply/v2/jobs/${p.id}?domain=${domain}`)).job_description;
  },
};

/** The newer API (Microsoft): "PCSX". */
const pcsx: EightfoldApi = {
  async search(host, domain, query, offset, hints) {
    const params = new URLSearchParams({ domain, query, start: String(offset) });
    if (hints?.country) params.set('location', hints.country.name);
    const page = await getJson<{ data?: { positions?: Position[]; count?: number } }>(
      `https://${host}/api/pcsx/search?${params}`,
    );
    return { items: page.data?.positions ?? [], total: page.data?.count };
  },
  async description(host, domain, p) {
    const d = await getJson<{ data?: { jobDescription?: string } }>(
      `https://${host}/api/pcsx/position_details?position_id=${p.id}&domain=${domain}&hl=en`,
    );
    return d.data?.jobDescription;
  },
};

/**
 * Eightfold, which runs Netflix's, Millennium's and Microsoft's careers sites.
 *
 * Handle: `<host>|<domain>`, e.g. `explore.jobs.netflix.net|netflix.com`. The
 * older API is tried first; a tenant that has moved answers "not authorized",
 * and then the newer one is used instead.
 */
export const eightfoldSource: Source = {
  id: 'eightfold',
  handleHint: 'host|domain, e.g. "explore.jobs.netflix.net|netflix.com"',

  async fetchJobs(handle, hints) {
    const [host, domain] = handle.split('|');
    if (!host || !domain) throw new Error(`Eightfold handle should look like "host|domain", got "${handle}"`);
    try {
      return await crawl(applyV2, host, domain, hints);
    } catch (err) {
      if (!/not authorized|pcsx|40[134]/i.test((err as Error).message)) throw err;
      return crawl(pcsx, host, domain, hints);
    }
  },
};

async function crawl(api: EightfoldApi, host: string, domain: string, hints?: FetchHints): Promise<DiscoveredJob[]> {
  const positions = await searchPaged(hints, 10, (query, offset) => api.search(host, domain, query, offset, hints));
  // The list carries at most a stub of the description; the detail has all of it.
  return hydrate(uniqueBy(positions, (p) => p.id), async (p) =>
    toJob(host, domain, { ...p, job_description: (await orElse(api.description(host, domain, p), undefined)) ?? p.job_description }),
    hints,
  );
}

function toJob(host: string, domain: string, p: Position): DiscoveredJob {
  const location = (p.locations?.length ? p.locations : [p.location]).filter(Boolean).join('; ');
  const path = p.canonicalPositionUrl ?? p.positionUrl ?? `/careers/job/${p.id}`;
  return {
    url: path.startsWith('http') ? path : `https://${host}${path}`,
    ats: 'eightfold',
    title: p.name,
    companyName: domain.split('.')[0]!,
    location: location || undefined,
    remote: remoteFromLabel(p.work_location_option ?? p.workLocationOption, location),
    descriptionText: stripHtml(p.job_description ?? ''),
    postedAt: fromEpochSeconds(p.t_create ?? p.postedTs),
  };
}
