import type { Page } from 'playwright';
import { getContext, newPage } from '../browser/session.js';
import { config } from '../lib/config.js';

/**
 * Getting onto LinkedIn as you, without ever handling your password.
 *
 * This reuses the same persistent Chromium profile the form filler uses, which
 * means signing in is something you do once, by hand, in a visible browser
 * window. Nothing here types a credential, stores one, or asks for one — the
 * app's only relationship with your LinkedIn login is noticing whether the
 * profile already has a live session cookie, and refusing to do anything if it
 * does not.
 *
 * That refusal is a feature. A scraper that silently lands on the logged-out
 * authwall does not fail; it succeeds at reading a page of nothing, and then
 * the outreach queue fills with drafts addressed to people it never actually
 * found.
 */

export class LinkedInSignInRequired extends Error {
  constructor(message?: string) {
    super(
      message ??
        'Not signed in to LinkedIn. The app never handles your password: open the browser window ' +
          'it controls, sign in to linkedin.com yourself, and run this again. The session lives in ' +
          `the Chromium profile at ${config.browserProfileDir} and persists across restarts.`,
    );
    this.name = 'LinkedInSignInRequired';
  }
}

/**
 * Whether the shared profile currently holds a LinkedIn session.
 *
 * The cookie, not the DOM, is the authority. `li_at` is the session cookie
 * LinkedIn sets on sign-in, and checking it costs nothing and needs no page
 * load — which matters because the alternative, navigating somewhere and
 * looking at what came back, is itself a request against an account we are
 * trying to keep unremarkable.
 */
export async function hasLinkedInSession(): Promise<boolean> {
  const ctx = await getContext();
  const cookies = await ctx.cookies('https://www.linkedin.com');
  return cookies.some((c) => c.name === 'li_at' && Boolean(c.value));
}

/** Pages LinkedIn serves when it wants a login instead of showing you the thing. */
const AUTH_WALL = /\/(authwall|login|uas\/login|checkpoint|signup)\b/;

/**
 * Navigate, pause, and fail loudly if we ended up logged out or challenged.
 *
 * The pause is not politeness theatre. Requests arriving back to back at
 * machine speed are the clearest signal that something automated is reading
 * the site, and this is the one place in the app driving a service that
 * actively looks for that.
 */
export async function openLinkedIn(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(config.linkedinDelayMs);

  const landed = page.url();
  if (AUTH_WALL.test(new URL(landed).pathname)) {
    throw new LinkedInSignInRequired(
      `LinkedIn redirected to ${landed}, which is its sign-in wall. Sign in by hand in the ` +
        'browser window this app controls, then run it again. If you are already signed in, ' +
        'LinkedIn has challenged the session — open the window and clear the challenge yourself.',
    );
  }
}

/**
 * A page for LinkedIn work, on the shared profile.
 *
 * Callers close it. One page is reused across a whole sweep rather than one
 * per request, because a fresh tab per profile visit is both slower and a
 * louder pattern than a person clicking through results.
 */
export async function linkedInPage(): Promise<Page> {
  if (!(await hasLinkedInSession())) throw new LinkedInSignInRequired();
  return newPage();
}

/**
 * Scroll a virtualised list until it stops growing.
 *
 * LinkedIn renders search results lazily and a plain `page.content()` sees
 * roughly the first seven of twenty-five. Bounded by both a pass count and a
 * no-growth check so a list that keeps loading forever cannot hang a sweep.
 */
export async function scrollToLoad(
  page: Page,
  selector: string,
  opts: { maxPasses?: number } = {},
): Promise<number> {
  const maxPasses = opts.maxPasses ?? 8;
  let previous = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const count = await page.locator(selector).count();
    if (count > 0 && count === previous) break;
    previous = count;
    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(Math.max(600, Math.round(config.linkedinDelayMs / 2)));
  }
  return previous;
}
