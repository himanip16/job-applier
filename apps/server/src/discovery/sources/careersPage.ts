import type { Page } from 'playwright';
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
