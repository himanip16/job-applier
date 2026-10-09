import type { Page } from 'playwright';
import type { ContactRole } from '../lib/db.js';
import { config } from '../lib/config.js';
import { openLinkedIn, scrollToLoad } from './session.js';
import { canonicalProfileUrl, headlineMatchesCompany } from './normalize.js';
import { classifyRole, isOutreachTarget } from './roles.js';
import { dedupeRepeat } from './jobs.js';

/**
 * Finding the two people at a company worth writing to.
 *
 * LinkedIn's people search is generous in the wrong direction: ask for
 * "Mercury recruiter" and it returns recruiters at Mercury, people who left
 * Mercury three years ago, recruiters hiring *for* Mercury from an agency, and
 * a long tail of people whose only connection is the word appearing somewhere
 * on their profile. So results are filtered twice — once on the headline
 * naming the company in the present tense, once on the title actually reading
 * as talent or engineering leadership — and what survives is capped.
 *
 * Two searches per company rather than one boolean query, because free
 * accounts get boolean operators quietly ignored and a single "recruiter OR
 * engineering manager" search returns neither reliably.
 */

export interface PersonResult {
  fullName: string;
  headline: string;
  profileUrl: string;
  location?: string;
  /** "1st" | "2nd" | "3rd+" — decides connection request vs direct message. */
  degree?: string;
  role: ContactRole;
  roleReason: string;
}

const DEGREE = /\b(1st|2nd|3rd\+?)\b/;

/** Chrome LinkedIn wraps around a name in the accessible label. */
const stripProfileChrome = (s: string): string =>
  s
    .replace(/^view\s+/i, '')
    .replace(/[’']s\s+profile$/i, '')
    .replace(/\s*[-–—]\s*\d+(st|nd|rd|th)\s*$/i, '')
    .replace(/\bstatus is (offline|online|reachable)\b/i, '')
    .trim();

function peopleSearchUrl(query: string): string {
  const url = new URL('https://www.linkedin.com/search/results/people/');
  url.searchParams.set('keywords', query);
  url.searchParams.set('origin', 'GLOBAL_SEARCH_HEADER');
  return url.toString();
}

/** Raw result cards off one people-search page. */
async function readPeople(page: Page): Promise<Omit<PersonResult, 'role' | 'roleReason'>[]> {
  await scrollToLoad(page, 'a[href*="/in/"]');

  const raw = await page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const out: { href: string; name: string; lines: string[]; cardText: string }[] = [];
    const seen = new Set<string>();

    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'))) {
      const href = a.href;
      if (seen.has(href)) continue;
      seen.add(href);

      const card =
        a.closest('li.reusable-search__result-container, li[class*="result"], div[data-view-name], li') ??
        a.parentElement;
      if (!card) continue;

      out.push({
        href,
        name: clean(a.getAttribute('aria-label')) || clean(a.textContent),
        lines: Array.from(card.querySelectorAll<HTMLElement>('span, div, p'))
          .map((el) => clean(el.textContent))
          .filter((t) => t.length > 0 && t.length < 200),
        cardText: clean(card.textContent).slice(0, 400),
      });
    }
    return out;
  });

  const people: Omit<PersonResult, 'role' | 'roleReason'>[] = [];
  const seenUrls = new Set<string>();

  for (const entry of raw) {
    const profileUrl = canonicalProfileUrl(entry.href);
    if (!profileUrl || seenUrls.has(profileUrl)) continue;

    const fullName = stripProfileChrome(dedupeRepeat(entry.name));
    // A card whose only link text is "LinkedIn Member" is an out-of-network
    // profile with no name and no way to message it.
    if (!fullName || /^linkedin member$/i.test(fullName)) continue;

    const lines = [...new Set(entry.lines.map(dedupeRepeat))].filter(
      (l) => l !== fullName && !DEGREE.test(l) && !/^(connect|message|follow|view profile)$/i.test(l),
    );

    seenUrls.add(profileUrl);
    people.push({
      fullName,
      headline: lines[0] ?? '',
      location: lines[1],
      degree: DEGREE.exec(entry.cardText)?.[1],
      profileUrl,
    });
  }

  return people;
}

/**
 * Talent and engineering-leadership contacts at one company.
 *
 * `perRole` caps each side independently so a company with forty recruiters
 * and one engineering manager does not produce forty recruiter drafts and
 * nothing else.
 */
export async function findContacts(
  page: Page,
  companyName: string,
  opts: { perRole?: number } = {},
): Promise<PersonResult[]> {
  const perRole = opts.perRole ?? config.linkedinContactsPerCompany;

  const queries = [
    `${companyName} recruiter talent acquisition`,
    `${companyName} engineering manager`,
  ];

  const byUrl = new Map<string, PersonResult>();

  for (const query of queries) {
    let found: Awaited<ReturnType<typeof readPeople>>;
    try {
      await openLinkedIn(page, peopleSearchUrl(query));
      found = await readPeople(page);
    } catch (err) {
      // One failed search must not lose the other. A company where only the
      // recruiter query worked still produces useful outreach.
      if ((err as Error).name === 'LinkedInSignInRequired') throw err;
      continue;
    }

    for (const person of found) {
      if (byUrl.has(person.profileUrl)) continue;
      // Present tense at this company, per the headline. This is what drops
      // the agency recruiters and the alumni.
      if (!headlineMatchesCompany(person.headline, companyName)) continue;

      const verdict = classifyRole(person.headline);
      if (!isOutreachTarget(verdict.role)) continue;

      byUrl.set(person.profileUrl, { ...person, role: verdict.role, roleReason: verdict.reason });
    }
  }

  const all = [...byUrl.values()];
  return [
    ...all.filter((p) => p.role === 'TALENT').slice(0, perRole),
    ...all.filter((p) => p.role === 'ENGINEERING').slice(0, perRole),
  ];
}
