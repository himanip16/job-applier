import type { Page } from 'playwright';
import type { DiscoveredJob } from '../discovery/sources.js';
import { config } from '../lib/config.js';
import { openLinkedIn, scrollToLoad } from './session.js';
import { jobIdFrom, jobUrlFor } from './normalize.js';

/**
 * Reading job postings off LinkedIn with the session you already have.
 *
 * LinkedIn publishes no jobs API for this, and the markup is generated class
 * names that change without notice, so every selector here is written as a
 * list of alternatives with a text-shaped fallback behind it. The rule
 * followed throughout: never let a selector miss turn into a silently empty
 * result. A card we cannot parse is dropped and counted, and a search that
 * parses nothing at all raises — because "found 0 jobs" and "the markup moved"
 * look identical from the outside and only one of them is worth acting on.
 */

export interface LinkedInJobCard {
  jobId: string;
  url: string;
  title: string;
  companyName: string;
  location?: string;
  /** LinkedIn's own promoted/verified flags, kept for display only. */
  easyApply: boolean;
}

export interface JobSearchOptions {
  keywords: string;
  location?: string;
  /** Only postings from the last week. LinkedIn's own `f_TPR=r604800`. */
  recentOnly?: boolean;
  remoteOnly?: boolean;
  /** Result pages, 25 postings each. */
  pages?: number;
}

/**
 * LinkedIn repeats the accessible name inside the visible one, so a card's
 * text routinely arrives as "Backend EngineerBackend Engineer".
 */
export function dedupeRepeat(text: string): string {
  const s = text.trim();
  if (s.length < 4 || s.length % 2 !== 0) return s;
  const half = s.length / 2;
  return s.slice(0, half) === s.slice(half) ? s.slice(0, half) : s;
}

function searchUrl(opts: JobSearchOptions, start: number): string {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  url.searchParams.set('keywords', opts.keywords);
  if (opts.location) url.searchParams.set('location', opts.location);
  if (opts.recentOnly !== false) url.searchParams.set('f_TPR', 'r604800');
  if (opts.remoteOnly) url.searchParams.set('f_WT', '2');
  url.searchParams.set('sortBy', 'DD');
  if (start > 0) url.searchParams.set('start', String(start));
  return url.toString();
}

export class LinkedInMarkupChanged extends Error {
  constructor(what: string) {
    super(
      `Could not parse any ${what} from LinkedIn's page. This almost always means LinkedIn ` +
        'changed its markup rather than that there were no results — check the browser window, ' +
        'and if the page does show results, the selectors in apps/server/src/linkedin/jobs.ts ' +
        'need updating.',
    );
    this.name = 'LinkedInMarkupChanged';
  }
}

/** One page of results, parsed. Exported for the pipeline's page loop. */
async function readCards(page: Page): Promise<{ cards: LinkedInJobCard[]; unparsed: number }> {
  await scrollToLoad(page, 'a[href*="/jobs/view/"]');

  const raw = await page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const out: {
      href: string;
      title: string;
      lines: string[];
      easyApply: boolean;
    }[] = [];

    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"]'),
    );
    const seen = new Set<string>();

    for (const a of anchors) {
      const href = a.href;
      if (seen.has(href)) continue;
      seen.add(href);

      const card =
        a.closest('[data-occludable-job-id], li.jobs-search-results__list-item, li, article, div.job-card-container') ??
        a.parentElement;
      if (!card) continue;

      // The accessible name is the most stable title source LinkedIn has; the
      // visible text is a fallback for layouts that do not set one.
      const title = clean(a.getAttribute('aria-label')) || clean(a.textContent);

      // Every line of the card, so the caller can pick company and location
      // out by position rather than by a class name that changes monthly.
      const lines = Array.from(card.querySelectorAll<HTMLElement>('span, div, li, p'))
        .map((el) => clean(el.textContent))
        .filter((t) => t.length > 0 && t.length < 120);

      out.push({
        href,
        title,
        lines,
        easyApply: /easy apply/i.test(clean(card.textContent)),
      });
    }
    return out;
  });

  const cards: LinkedInJobCard[] = [];
  let unparsed = 0;
  const seenIds = new Set<string>();

  for (const entry of raw) {
    const jobId = jobIdFrom(entry.href);
    const title = dedupeRepeat(entry.title);
    if (!jobId || !title) {
      unparsed++;
      continue;
    }
    if (seenIds.has(jobId)) continue;
    seenIds.add(jobId);

    // Drop the title and its duplicates, then the first two surviving lines
    // are company and location in every layout LinkedIn currently ships.
    const rest = entry.lines
      .map(dedupeRepeat)
      .filter((l) => l !== title && !/^(easy apply|promoted|viewed|actively reviewing|be an early applicant)$/i.test(l));
    const unique = [...new Set(rest)];

    cards.push({
      jobId,
      url: jobUrlFor(jobId),
      title,
      companyName: unique[0] ?? '',
      location: unique[1],
      easyApply: entry.easyApply,
    });
  }

  return { cards, unparsed };
}

/**
 * Every posting the search returns, across the requested pages.
 *
 * Stops early when a page returns nothing new, which is how LinkedIn signals
 * the end of a result set — it keeps serving a valid page past the last one
 * rather than 404ing.
 */
export async function searchJobs(page: Page, opts: JobSearchOptions): Promise<LinkedInJobCard[]> {
  const pages = Math.max(1, opts.pages ?? config.linkedinJobPages);
  const all = new Map<string, LinkedInJobCard>();
  let parsedAnything = false;

  for (let i = 0; i < pages; i++) {
    await openLinkedIn(page, searchUrl(opts, i * 25));
    const { cards } = await readCards(page);
    if (cards.length) parsedAnything = true;

    const before = all.size;
    for (const card of cards) all.set(card.jobId, card);
    if (all.size === before) break;
  }

  if (!parsedAnything) throw new LinkedInMarkupChanged('job cards');
  return [...all.values()];
}

/** A posting that has closed. Kept as a distinct outcome, not an error. */
export const CLOSED = Symbol('closed');

/**
 * Open one posting and read its description.
 *
 * Returns CLOSED for postings LinkedIn still serves but has stopped accepting
 * applications for. "All the active jobs" has to mean active: a closed posting
 * is worse than no posting, because it costs a real message to a real person
 * about a role that no longer exists.
 */
export async function hydrateJob(
  page: Page,
  card: LinkedInJobCard,
): Promise<DiscoveredJob | typeof CLOSED> {
  await openLinkedIn(page, card.url);

  // The description is collapsed behind a "see more" button on most layouts.
  const seeMore = page
    .locator('button.jobs-description__footer-button, button[aria-label*="see more" i], button:has-text("Show more")')
    .first();
  if (await seeMore.count().then((n) => n > 0).catch(() => false)) {
    await seeMore.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
  }

  const detail = await page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? '').replace(/[ \t]+/g, ' ').trim();
    const pick = (selectors: string[]): string => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const text = clean(el?.textContent);
        if (text) return text;
      }
      return '';
    };

    return {
      title: pick(['h1', '.job-details-jobs-unified-top-card__job-title', '.top-card-layout__title']),
      company: pick([
        '.job-details-jobs-unified-top-card__company-name',
        '.topcard__org-name-link',
        '.top-card-layout__second-subline a',
      ]),
      meta: pick([
        '.job-details-jobs-unified-top-card__primary-description-container',
        '.jobs-unified-top-card__primary-description',
        '.top-card-layout__second-subline',
      ]),
      description: pick([
        '.jobs-description__content',
        '#job-details',
        '.jobs-box__html-content',
        '.description__text',
        'article',
      ]),
      // LinkedIn words this a few ways depending on why it closed.
      closed: /no longer accepting applications|this job is no longer available|applications are closed/i.test(
        clean(document.body.textContent).slice(0, 20000),
      ),
    };
  });

  if (detail.closed) return CLOSED;

  const meta = detail.meta;
  const workplace = /\b(remote|hybrid|on-?site)\b/i.exec(meta)?.[0]?.toLowerCase();

  return {
    url: card.url,
    ats: 'linkedin',
    title: detail.title || card.title,
    companyName: detail.company || card.companyName,
    location: card.location ?? (meta ? meta.split('·')[0]?.trim() : undefined),
    // The posting's own workplace tag beats guessing from the description, and
    // "hybrid" said explicitly is a fact that outranks a stray "remote" in the
    // benefits paragraph.
    remote: workplace === 'remote',
    descriptionText: detail.description,
    postedAt: undefined,
  };
}

/**
 * Where the posting's Apply button actually goes.
 *
 * This matters for the half of the feature that submits applications. Most
 * LinkedIn postings are not Easy Apply — they hand off to the company's own
 * Greenhouse, Lever or Ashby form, and that is the URL the existing form
 * engine knows how to drive. Handing it the LinkedIn page instead means the
 * generic adapter tries to fill LinkedIn's own chrome, which fails in a
 * confusing way.
 *
 * Deliberately called at apply time rather than during a sweep: it costs a
 * page load and sometimes a popup per job, which is not worth spending on
 * postings you are never going to act on.
 *
 * Returns null for Easy Apply and for anything it cannot resolve, and the
 * caller falls back to the LinkedIn URL.
 */
export async function resolveApplyUrl(page: Page, jobUrl: string): Promise<string | null> {
  await openLinkedIn(page, jobUrl);

  const button = page
    .locator('.jobs-apply-button, button[aria-label*="Apply" i], a[aria-label*="Apply" i]')
    .first();
  if (!(await button.count().then((n) => n > 0).catch(() => false))) return null;

  // Easy Apply keeps you on LinkedIn, so there is no external URL to find and
  // the existing engine has nothing better to drive than the page itself.
  const label = ((await button.getAttribute('aria-label').catch(() => '')) ?? '') +
    ((await button.textContent().catch(() => '')) ?? '');
  if (/easy apply/i.test(label)) return null;

  // Some layouts render the offsite apply as a plain link, which needs no click.
  const href = await button.getAttribute('href').catch(() => null);
  if (href && !/linkedin\.com/.test(href)) return href;

  // Otherwise it opens a new tab. Wait for it, read the URL, close it — never
  // leave a stray page behind on the shared context.
  const context = page.context();
  const popupPromise = context.waitForEvent('page', { timeout: 12_000 }).catch(() => null);
  await button.click({ timeout: 8000 }).catch(() => {});
  const popup = await popupPromise;
  if (!popup) return null;

  try {
    await popup.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => {});
    const url = popup.url();
    return url && !/linkedin\.com/.test(url) ? url : null;
  } finally {
    await popup.close().catch(() => {});
  }
}
