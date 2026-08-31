import type { Page } from 'playwright';
import type { ContactRole, SyncType } from '../lib/db.js';
import { prisma } from '../lib/db.js';
import { openLinkedIn, linkedInPage, scrollToLoad } from './session.js';
import { canonicalProfileUrl, headlineMatchesCompany } from './normalize.js';
import { classifyRole, isOutreachTarget } from './roles.js';
import { dedupeRepeat } from './jobs.js';

const DEGREE = /\b(1st|2nd|3rd\+?)\b/;

/**
 * Chrome LinkedIn wraps around a name in the accessible label.
 */
const stripProfileChrome = (s: string): string =>
  s
    .replace(/^view\s+/i, '')
    .replace(/[’']s\s+profile$/i, '')
    .replace(/\s*[-–—]\s*\d+(st|nd|rd|th)\s*$/i, '')
    .replace(/\bstatus is (offline|online|reachable)\b/i, '')
    .trim();

/**
 * Read connections from LinkedIn's network page.
 */
async function readConnections(page: Page): Promise<{
  fullName: string;
  headline: string;
  profileUrl: string;
  location?: string;
  degree?: string;
  companyName?: string;
}[]> {
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

  const connections: {
    fullName: string;
    headline: string;
    profileUrl: string;
    location?: string;
    degree?: string;
    companyName?: string;
  }[] = [];
  const seenUrls = new Set<string>();

  for (const entry of raw) {
    const profileUrl = canonicalProfileUrl(entry.href);
    if (!profileUrl || seenUrls.has(profileUrl)) continue;

    const fullName = stripProfileChrome(dedupeRepeat(entry.name));
    if (!fullName || /^linkedin member$/i.test(fullName)) continue;

    const lines = [...new Set(entry.lines.map(dedupeRepeat))].filter(
      (l) => l !== fullName && !DEGREE.test(l) && !/^(connect|message|follow|view profile)$/i.test(l),
    );

    seenUrls.add(profileUrl);
    
    // Extract company from headline if present
    const headline = lines[0] ?? '';
    let companyName: string | undefined;
    const companyMatch = headline.match(/at\s+([^.]+)/i);
    if (companyMatch && companyMatch[1]) {
      companyName = companyMatch[1].trim();
    }

    connections.push({
      fullName,
      headline,
      location: lines[1],
      degree: DEGREE.exec(entry.cardText)?.[1],
      profileUrl,
      companyName,
    });
  }

  return connections;
}

/**
 * Sync LinkedIn connections into the database.
 */
export async function syncConnections(profileId: string): Promise<{
  synced: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let synced = 0;

  // Update sync status to running
  await prisma.linkedInSync.upsert({
    where: { profileId_syncType: { profileId, syncType: 'CONNECTIONS' } },
    update: { status: 'RUNNING', error: null },
    create: { profileId, syncType: 'CONNECTIONS', status: 'RUNNING' },
  });

  try {
    const page = await linkedInPage();
    
    // Navigate to connections page
    await openLinkedIn(page, 'https://www.linkedin.com/mynetwork/contacts/connect/');
    
    // Read all connections
    const connections = await readConnections(page);
    
    // Upsert each connection
    for (const conn of connections) {
      try {
        // Classify role
        const roleVerdict = classifyRole(conn.headline);
        const role: ContactRole = isOutreachTarget(roleVerdict.role) ? roleVerdict.role : 'OTHER';
        
        // Normalize company key
        const companyKey = conn.companyName 
          ? conn.companyName.toLowerCase().replace(/[^a-z0-9]/g, '')
          : 'unknown';

        await prisma.contact.upsert({
          where: { profileId_profileUrl: { profileId, profileUrl: conn.profileUrl } },
          update: {
            fullName: conn.fullName,
            headline: conn.headline,
            companyName: conn.companyName ?? 'Unknown',
            companyKey,
            location: conn.location,
            degree: conn.degree,
            role,
            roleReason: roleVerdict.reason,
            isConnection: true,
            lastSyncedAt: new Date(),
          },
          create: {
            profileId,
            fullName: conn.fullName,
            headline: conn.headline,
            companyName: conn.companyName ?? 'Unknown',
            companyKey,
            location: conn.location,
            profileUrl: conn.profileUrl,
            role,
            roleReason: roleVerdict.reason,
            degree: conn.degree,
            isConnection: true,
            lastSyncedAt: new Date(),
          },
        });
        
        synced++;
      } catch (err) {
        errors.push(`Failed to sync ${conn.fullName}: ${(err as Error).message}`);
      }
    }

    await page.close();

    // Update sync status to completed
    await prisma.linkedInSync.upsert({
      where: { profileId_syncType: { profileId, syncType: 'CONNECTIONS' } },
      update: { status: 'COMPLETED', lastSyncAt: new Date(), error: null },
      create: { profileId, syncType: 'CONNECTIONS', status: 'COMPLETED', lastSyncAt: new Date() },
    });

  } catch (err) {
    const error = (err as Error).message;
    errors.push(error);
    
    // Update sync status to failed
    await prisma.linkedInSync.upsert({
      where: { profileId_syncType: { profileId, syncType: 'CONNECTIONS' } },
      update: { status: 'FAILED', error },
      create: { profileId, syncType: 'CONNECTIONS', status: 'FAILED', error },
    });
  }

  return { synced, errors };
}

/**
 * Get sync status for a profile.
 */
export async function getSyncStatus(profileId: string, syncType: SyncType) {
  return prisma.linkedInSync.findUnique({
    where: { profileId_syncType: { profileId, syncType } },
  });
}
