import type { Page } from 'playwright';
import { jobPostingsFromLd, type LdJobPosting } from './jobPostingLd.js';
import { looksRemote } from './text.js';
import type { DiscoveredJob } from './types.js';

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
 *
 * A page's schema.org JobPosting block, when it has one, is read first: it
 * states the location and posting date the rendered page buries or leaves
 * out. Without it a posting has no location at all, and the queue says so
 * rather than assuming it is in the country you searched.
 */
export async function crawlCareersPage(
  page: Page,
  startUrl: string,
  opts: { maxPages?: number; maxDepth?: number; delayMs?: number } = {},
): Promise<DiscoveredJob[]> {
  const maxPages = opts.maxPages ?? 40;
  const maxDepth = opts.maxDepth ?? 10;
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
        ld: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent ?? ''),
        siteName:
          clean(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')) ||
          location.hostname.replace(/^(www|jobs|careers|apply)\./, '').split('.')[0] ||
          '',
      };
    });

    const company = info.siteName || start.hostname;
    const ld = jobPostingsFromLd(info.ld);

    if (ld.length > 1) {
      // An index page describing each of its postings: keep the ones that say where they live.
      for (const posting of ld) {
        const at = resolve(posting.url, url);
        if (at && posting.title && !found.has(at)) found.set(at, fromLd(posting, at, company));
      }
    }

    const own = ld.length === 1 ? ld[0] : undefined;
    const isPosting =
      !!own?.title ||
      info.hasApplyForm ||
      (JOB_URL_HINTS.test(url) && info.title.length > 0 && info.bodyText.length > 400);

    if (isPosting && (own?.title || info.title)) {
      found.set(url, own ? fromLd(own, url, company, info) : {
        url,
        ats: detectAts(url),
        title: info.title,
        companyName: company,
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

/**
 * A posting from its JSON-LD, with the rendered page filling only what the
 * block left out. Location and date come from the block or not at all.
 */
function fromLd(
  ld: LdJobPosting,
  url: string,
  company: string,
  page?: { title: string; bodyText: string },
): DiscoveredJob {
  const title = ld.title || page?.title || '';
  const descriptionText = ld.descriptionText || page?.bodyText || '';
  return {
    url,
    ats: detectAts(url),
    title,
    companyName: ld.companyName || company,
    location: ld.location,
    remote: ld.remote || (!ld.location && looksRemote(`${title} ${descriptionText.slice(0, 1500)}`)),
    descriptionText,
    postedAt: ld.postedAt,
  };
}

const resolve = (href: string | undefined, base: string): string | undefined => {
  if (!href) return undefined;
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
};

function detectAts(url: string): string {
  if (/greenhouse\.io/.test(url)) return 'greenhouse';
  if (/lever\.co/.test(url)) return 'lever';
  if (/ashbyhq\.com/.test(url)) return 'ashby';
  if (/workable\.com/.test(url)) return 'workable';
  return 'generic';
}
