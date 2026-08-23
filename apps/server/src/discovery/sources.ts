/**
 * Where job leads come from.
 *
 * Four of the five sources are the boards' own public, unauthenticated
 * postings APIs. They exist because the platforms want aggregators and company
 * websites to read them, so using them is both sanctioned and far more
 * reliable than parsing a rendered React page: structured JSON, full
 * description text, stable ids, no rate-limit games, no bot detection.
 *
 * The fifth is a real crawl, for companies that run their own careers page.
 * That one is best-effort and depth-limited.
 */
import type { Page } from 'playwright';

export interface DiscoveredJob {
  url: string;
  ats: string;
  title: string;
  companyName: string;
  location?: string;
  remote: boolean;
  descriptionText: string;
  postedAt?: Date;
}

export interface Source {
  id: string;
  /** Human-readable hint for what `handle` should be. */
  handleHint: string;
  fetchJobs(handle: string): Promise<DiscoveredJob[]>;
}

const UA = 'job-applier/0.1 (personal job search assistant)';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return (await res.json()) as T;
}

const removeTags = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

const decodeEntities = (text: string): string =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#3[49];|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#(\d{2,5});/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // Last, deliberately: decoding it first would turn `&amp;lt;` straight
    // into `<` and hide a level of escaping from the next pass.
    .replace(/&amp;/g, '&');

/**
 * Turn a board's description into text a human and a tokeniser can both read.
 *
 * Stripping and unescaping have to alternate, not happen once each in that
 * order. Greenhouse returns `content` as HTML that is itself HTML-escaped, so
 * one pass removes no tags at all (there are none yet) and then unescapes
 * `&lt;span style="..."&gt;` into real markup, which lands in the description
 * verbatim. The lexical scorer then learns from it: a live queue had jobs
 * whose top matched terms were `span`, `nbsp` and `props`, and one scored 94%
 * on them.
 *
 * Three passes is enough for the double-escaping seen in the wild, and the
 * loop stops as soon as a pass changes nothing.
 */
const stripHtml = (html: string): string => {
  let text = html;
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeEntities(removeTags(text));
    if (next === text) break;
    text = next;
  }
  return removeTags(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const looksRemote = (s: string): boolean => /\bremote\b|\bwork from home\b|\bdistributed\b/i.test(s);

// --------------------------------------------------------------- greenhouse ---

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

// -------------------------------------------------------------------- lever ---

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
        remote: p.workplaceType === 'remote' || looksRemote(`${loc} ${p.text}`),
        descriptionText: [p.descriptionPlain ?? stripHtml(p.description ?? ''), extras]
          .filter(Boolean)
          .join('\n\n'),
        postedAt: p.createdAt ? new Date(p.createdAt) : undefined,
      };
    });
  },
};

// -------------------------------------------------------------------- ashby ---

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
        remote: Boolean(j.isRemote) || looksRemote(j.location ?? ''),
        descriptionText: j.descriptionPlain ?? stripHtml(j.descriptionHtml ?? ''),
        postedAt: j.publishedAt ? new Date(j.publishedAt) : undefined,
      }));
  },
};

// ----------------------------------------------------------------- workable ---

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
    const res = await fetch(
      `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(handle)}/jobs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
        body: JSON.stringify({ query: '', location: [], department: [], worktype: [], remote: [] }),
      },
    );
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from Workable`);
    const data = (await res.json()) as { results?: WorkableJob[] };
    return (data.results ?? []).map((j) => {
      const loc = [j.location?.city, j.location?.country].filter(Boolean).join(', ');
      return {
        url: j.url ?? `https://apply.workable.com/${handle}/j/${j.shortcode}/`,
        ats: 'workable',
        title: j.title,
        companyName: handle,
        location: loc || undefined,
        remote: j.location?.workplace === 'remote' || looksRemote(loc),
        descriptionText: stripHtml(j.description ?? ''),
        postedAt: j.published ? new Date(j.published) : undefined,
      };
    });
  },
};

export const API_SOURCES: Source[] = [greenhouseSource, leverSource, ashbySource, workableSource];

export const sourceById = (id: string): Source | undefined => API_SOURCES.find((s) => s.id === id);

// -------------------------------------------------------------- careers page ---

/** Links that look like a posting rather than navigation chrome. */
const JOB_URL_HINTS =
  /\/(jobs?|careers?|openings?|positions?|vacanc(y|ies)|opportunit(y|ies))\/[^/]+|\/job[-_]?(id|posting)|greenhouse\.io\/[^/]+\/jobs\/\d+|lever\.co\/[^/]+\/[0-9a-f-]{20,}|ashbyhq\.com\/[^/]+\/[0-9a-f-]{20,}/i;
const NON_JOB = /\.(pdf|png|jpe?g|gif|svg|zip|css|js)(\?|$)|\/(privacy|cookie|legal|terms|blog|news|press)\b/i;

/**
 * Breadth-first crawl of a company's own careers site.
 *
 * Deliberately conservative: same origin only (plus the three ATS hosts a
 * careers page commonly links out to), a hard page budget, a depth limit, and
 * a pause between fetches. This is someone's website, not a dataset.
 */
export async function crawlCareersPage(
  page: Page,
  startUrl: string,
  opts: { maxPages?: number; maxDepth?: number; delayMs?: number } = {},
): Promise<DiscoveredJob[]> {
  const maxPages = opts.maxPages ?? 40;
  const maxDepth = opts.maxDepth ?? 2;
  const delayMs = opts.delayMs ?? 400;

  const start = new URL(startUrl);
  const allowedHosts = new Set([
    start.hostname,
    'job-boards.greenhouse.io',
    'boards.greenhouse.io',
    'jobs.lever.co',
    'jobs.ashbyhq.com',
    'apply.workable.com',
  ]);

  const seen = new Set<string>([startUrl]);
  const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
  const found = new Map<string, DiscoveredJob>();
  let fetched = 0;

  while (queue.length && fetched < maxPages) {
    const { url, depth } = queue.shift()!;
    fetched++;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForTimeout(delayMs);
    } catch {
      continue;
    }

    const info = await page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      return {
        title: clean(document.querySelector('h1')?.textContent),
        // A page that has an application form is a posting, not an index.
        hasApplyForm: !!document.querySelector(
          'form input[type="file"], form#application-form, [class*="application"] form',
        ),
        bodyText: clean(document.querySelector('main, article, body')?.textContent).slice(0, 20000),
        links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((a) => a.href),
        siteName:
          clean(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')) ||
          location.hostname.replace(/^(www|jobs|careers|apply)\./, '').split('.')[0] ||
          '',
      };
    });

    const isPosting =
      info.hasApplyForm ||
      (JOB_URL_HINTS.test(url) && info.title.length > 0 && info.bodyText.length > 400);

    if (isPosting && info.title) {
      found.set(url, {
        url,
        ats: detectAts(url),
        title: info.title,
        companyName: info.siteName || start.hostname,
        remote: looksRemote(`${info.title} ${info.bodyText.slice(0, 1500)}`),
        descriptionText: info.bodyText,
      });
    }

    if (depth >= maxDepth) continue;

    for (const raw of info.links) {
      let link: URL;
      try {
        link = new URL(raw);
      } catch {
        continue;
      }
      link.hash = '';
      const href = link.toString();
      if (seen.has(href)) continue;
      if (!allowedHosts.has(link.hostname)) continue;
      if (NON_JOB.test(href)) continue;
      // Follow links that either look like postings or look like an index page
      // that would contain them.
      if (!JOB_URL_HINTS.test(href) && !/careers?|jobs?|openings?/i.test(href)) continue;
      seen.add(href);
      queue.push({ url: href, depth: depth + 1 });
    }
  }

  return [...found.values()];
}

function detectAts(url: string): string {
  if (/greenhouse\.io/.test(url)) return 'greenhouse';
  if (/lever\.co/.test(url)) return 'lever';
  if (/ashbyhq\.com/.test(url)) return 'ashby';
  if (/workable\.com/.test(url)) return 'workable';
  return 'generic';
}
