import type { Page } from 'playwright';
import { config } from '../lib/config.js';
import { canonicalProfileUrl } from './normalize.js';
import { dedupeRepeat } from './jobs.js';

export interface Connection {
  fullName: string;
  headline: string;
  profileUrl: string;
  companyName?: string;
  location?: string;
  degree: '1st';
}

/** Self-contained because Playwright executes this function in the page. */
export function connectionCardsInDocument() {
  const root = document.querySelector('main, [role="main"]');
  if (!root) return [];
  const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const rows: { href: string; name: string; headline: string; location: string }[] = [];
  const seenCards = new Set<Element>();
  const profilePath = (a: HTMLAnchorElement) => {
    try { return new URL(a.href).pathname.replace(/\/$/, ''); } catch { return ''; }
  };

  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')) {
    let card = anchor.closest('.mn-connection-card');
    if (!card) {
      // Modern cards use generated class names. Stop before climbing into a
      // container with several people, and require a connection-specific action.
      let parent = anchor.parentElement;
      while (parent && parent !== root) {
        const profiles = new Set(Array.from(parent.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')).map(profilePath));
        if (profiles.size > 1) break;
        const connected = /\bconnected\s+(?:on|since|\d|today|yesterday)/i.test(parent.textContent ?? '');
        const message = Array.from(parent.querySelectorAll('button, a')).some((element) =>
          /^message(?:\s|$)/i.test(clean(element.getAttribute('aria-label') || element.textContent)));
        if (connected || message) { card = parent; break; }
        parent = parent.parentElement;
      }
    }
    if (!card || seenCards.has(card) || !(card as HTMLElement).getClientRects().length) continue;
    seenCards.add(card);

    const links = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'));
    // The photo and name often link to the very same URL. Never let the empty
    // photo anchor consume the identity before we inspect the text link.
    const textLink = links.find((link) => clean(link.innerText)) ?? links.find((link) => clean(link.getAttribute('aria-label')));
    const nameElement = card.querySelector('.mn-connection-card__name, [data-field="name"]');
    const linkLines = (textLink?.innerText ?? '').split('\n').map(clean).filter(Boolean);
    const name = clean(nameElement?.textContent) || linkLines[0] || clean(textLink?.getAttribute('aria-label'));
    const headlineElement = card.querySelector('.mn-connection-card__occupation, [data-field="headline"]');
    const lines = (card as HTMLElement).innerText.split('\n').map(clean).filter(Boolean);
    const nameIndex = lines.findIndex((line) => line === name);
    const headline = clean(headlineElement?.textContent) || lines.slice(Math.max(0, nameIndex + 1)).find((line) =>
      line !== name && !/^(message|more|connect|follow|remove connection|\d+(?:st|nd|rd|th)\+?|connected\b|status is\b|show all\b)/i.test(line)) || '';
    rows.push({
      href: textLink?.href ?? anchor.href,
      name,
      headline,
      // Connection dates and buttons are not locations. Only use a dedicated field.
      location: clean(card.querySelector('[data-field="location"], .mn-connection-card__location')?.textContent),
    });
  }
  return rows;
}

/** Read before every scroll: virtual lists can replace cards without growing. */
export async function readConnections(page: Page, options: {
  maxPasses?: number;
  delayMs?: number;
  onConnection?: (connection: Connection) => Promise<void>;
} = {}): Promise<Connection[]> {
  const byUrl = new Map<string, Connection>();
  const delay = options.delayMs ?? Math.max(800, config.linkedinDelayMs);
  let idle = 0;

  for (let pass = 0; pass < (options.maxPasses ?? 500); pass++) {
    if (/\/(authwall|login|uas\/login|checkpoint|signup)\b/.test(new URL(page.url()).pathname)) {
      throw new Error('LinkedIn needs sign-in or verification. Complete it in the Job Applier browser, then sync again.');
    }
    const before = byUrl.size;
    for (const row of await page.evaluate(connectionCardsInDocument)) {
      let profileUrl: string | null;
      try { profileUrl = canonicalProfileUrl(row.href); } catch { continue; }
      const fullName = dedupeRepeat(row.name)
        .replace(/^view\s+/i, '').replace(/[’']s\s+profile$/i, '')
        .replace(/\s*[-–—]\s*\d+(?:st|nd|rd|th)\+?\s*$/i, '')
        .replace(/\bstatus is (offline|online|reachable)\b/i, '').trim();
      if (!profileUrl || !fullName || /^(linkedin member|message|view profile)$/i.test(fullName) || byUrl.has(profileUrl)) continue;
      const headline = dedupeRepeat(row.headline);
      const companyName = headline.match(/\s(?:at|@)\s+(.+?)(?=\s*[|•·]|$)/i)?.[1]?.trim();
      const connection: Connection = { profileUrl, fullName, headline, companyName, location: row.location || undefined, degree: '1st' };
      byUrl.set(profileUrl, connection);
      await options.onConnection?.(connection);
    }
    idle = byUrl.size === before ? idle + 1 : 0;

    const root = page.locator('main, [role="main"]').first();
    const more = root.getByRole('button', { name: /^(show more(?: results)?|load more(?: connections)?|see more results)$/i }).first();
    if (await more.isVisible() && await more.isEnabled()) {
      await more.click();
      await page.waitForTimeout(delay);
      continue;
    }

    const moved = await page.evaluate(() => {
      const root = document.querySelector('main, [role="main"]');
      let parent = root?.querySelector('a[href*="/in/"]')?.parentElement ?? null;
      let scroller = document.scrollingElement;
      while (parent) {
        if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) { scroller = parent; break; }
        parent = parent.parentElement;
      }
      if (!scroller) return false;
      const previous = scroller.scrollTop;
      scroller.scrollTop += Math.max(400, scroller.clientHeight * 0.8);
      return scroller.scrollTop > previous;
    });

    if (!moved && idle >= 4) {
      const next = root.locator('.artdeco-pagination, nav[aria-label*="agination"]').getByRole('button', { name: /^next(?: page)?$/i }).first();
      if (await next.isVisible() && await next.isEnabled()) {
        await next.click();
        idle = 0;
      } else {
        return [...byUrl.values()];
      }
    }
    await page.waitForTimeout(delay);
  }
  throw new Error(`Stopped after the connection reader's page limit. Read ${byUrl.size} connections; sync is incomplete.`);
}
