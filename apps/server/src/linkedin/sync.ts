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
 * 
 * Accumulates connections continuously during scrolling to handle DOM virtualization.
 * LinkedIn unmounts DOM nodes that scroll out of viewport, so we must scrape
 * as we scroll rather than querying once at the end.
 */
async function readConnections(page: Page): Promise<{
  fullName: string;
  headline: string;
  profileUrl: string;
  location?: string;
  degree?: string;
  companyName?: string;
}[]> {
  const connections: {
    fullName: string;
    headline: string;
    profileUrl: string;
    location?: string;
    degree?: string;
    companyName?: string;
  }[] = [];
  const seenUrls = new Set<string>();
  let previousCount = 0;
  let noGrowthCount = 0;
  const maxNoGrowth = 3; // Stop after 3 passes with no new connections

  // Scroll and accumulate connections to handle DOM virtualization
  for (let pass = 0; pass < 20; pass++) { // Increased max passes for large networks
    // Scrape current viewport
    const raw = await page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const out: { href: string; name: string; lines: string[]; cardText: string }[] = [];
      const seen = new Set<string>();

      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'))) {
        const href = a.href;
        if (seen.has(href)) continue;
        seen.add(href);

        // Find the connection card - look for specific connection card containers
        // Skip if the link is within mutual connections or similar sub-sections
        const mutualSection = a.closest('[class*="mutual"], [class*="shared"], [class*="member"]');
        if (mutualSection) continue;

        const card =
          a.closest('li.reusable-search__result-container, li[class*="result"], div[data-view-name], li.pv-contact') ??
          a.parentElement;
        if (!card) continue;

        // Skip if this appears to be a secondary link within the same card
        const primaryLinks = card.querySelectorAll('a[href*="/in/"]');
        if (primaryLinks.length > 1 && primaryLinks[0] !== a) continue;

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

    // Process scraped data
    let newConnectionsThisPass = 0;
    for (const entry of raw) {
      const profileUrl = canonicalProfileUrl(entry.href);
      if (!profileUrl || seenUrls.has(profileUrl)) continue;

      const fullName = stripProfileChrome(dedupeRepeat(entry.name));
      if (!fullName || /^linkedin member$/i.test(fullName)) continue;

      const lines = [...new Set(entry.lines.map(dedupeRepeat))].filter(
        (l) => l !== fullName && !DEGREE.test(l) && !/^(connect|message|follow|view profile)$/i.test(l),
      );

      seenUrls.add(profileUrl);
      newConnectionsThisPass++;
      
      // Extract company from headline if present
      const headline = lines[0] ?? '';
      let companyName: string | undefined;
      // Handle both "at" and "@" as company indicators, with better delimiters
      const companyMatch = headline.match(/(?:at|@)\s+([^|,\n]*(?:Inc|Corp|LLC|Ltd|GmbH|Technologies|Solutions|Company|Group|Labs|Studios|Systems|Networks|Services|Platform|Cloud|Data|AI|Software|Engineering|Design|Marketing|Sales|Finance|Ops|Digital|Global|International|America|Europe|Asia|Pacific|USA|UK|India|Canada|Australia)?[^|,\n]*)/i);
      if (companyMatch && companyMatch[1]) {
        companyName = companyMatch[1].trim()
          .replace(/\s*\|\s*.*$/, '') // Remove anything after pipe
          .replace(/\s*,\s*.*$/, '') // Remove anything after comma
          .replace(/\s+(?:Ex-|Former|Previous|Past)\s+.*$/i, '') // Remove "Ex-Company" references
          .trim();
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

    // Check if we found new connections
    if (newConnectionsThisPass === 0) {
      noGrowthCount++;
      if (noGrowthCount >= maxNoGrowth) break; // Stop if no growth for multiple passes
    } else {
      noGrowthCount = 0;
    }

    // Scroll down to load more
    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(800); // Increased delay for reliability
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

  // Check connection status
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { linkedinConnectionStatus: true },
  });

  if (!profile || profile.linkedinConnectionStatus !== 'CONNECTED') {
    throw new Error('LinkedIn is not connected. Please connect your LinkedIn account first.');
  }

  // Update sync status to running
  await prisma.linkedInSync.upsert({
    where: { profileId_syncType: { profileId, syncType: 'CONNECTIONS' } },
    update: { status: 'RUNNING', error: null, startedAt: new Date() },
    create: { profileId, syncType: 'CONNECTIONS', status: 'RUNNING', startedAt: new Date() },
  });

  let page: Page | null = null;
  try {
    page = await linkedInPage();
    
    // Navigate to connections page (actual 1st-degree connections list)
    await openLinkedIn(page, 'https://www.linkedin.com/mynetwork/invite-connect/connections/');
    
    // Read all connections
    const connections = await readConnections(page);
    
    // Upsert each connection
    for (const conn of connections) {
      try {
        // Update heartbeat every 10 connections to detect stuck syncs
        if (synced % 10 === 0) {
          await prisma.linkedInSync.update({
            where: { profileId_syncType: { profileId, syncType: 'CONNECTIONS' } },
            data: { heartbeatAt: new Date() },
          });
        }

        // Classify role
        const roleVerdict = classifyRole(conn.headline);
        const role: ContactRole = isOutreachTarget(roleVerdict.role) ? roleVerdict.role : 'OTHER';
        
        // Normalize company key
        const companyKey = conn.companyName 
          ? conn.companyName.toLowerCase().replace(/[^a-z0-9]/g, '')
          : 'unknown';

        // Build update object - preserve existing company data if new data is invalid
        const updateData: Record<string, any> = {
          fullName: conn.fullName,
          headline: conn.headline,
          location: conn.location,
          degree: conn.degree,
          role,
          roleReason: roleVerdict.reason,
          isConnection: true,
          lastSyncedAt: new Date(),
        };

        // Only update company info if we have valid company data
        if (conn.companyName && conn.companyName !== 'Unknown') {
          updateData.companyName = conn.companyName;
          updateData.companyKey = companyKey;
        }

        await prisma.contact.upsert({
          where: { profileId_profileUrl: { profileId, profileUrl: conn.profileUrl } },
          update: updateData,
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
            discoveredAt: new Date(), // Explicitly set on create
          },
        });
        
        synced++;
      } catch (err) {
        errors.push(`Failed to sync ${conn.fullName}: ${(err as Error).message}`);
      }
    }

    // Update sync status to completed
    await prisma.linkedInSync.upsert({
      where: { profileId_syncType: { profileId, syncType: 'CONNECTIONS' } },
      update: { 
        status: 'COMPLETED', 
        lastSyncAt: new Date(), 
        error: null,
        heartbeatAt: new Date(), // Final heartbeat
      },
      create: { profileId, syncType: 'CONNECTIONS', status: 'COMPLETED', lastSyncAt: new Date() },
    });

  } catch (err) {
    const error = (err as Error).message;
    errors.push(error);
    
    // Check if this is a LinkedIn session issue
    const isSessionError = error.includes('LinkedIn') || 
                          error.includes('sign-in') || 
                          error.includes('challenge') ||
                          error.includes('authwall');
    
    // Update sync status to failed
    await prisma.linkedInSync.upsert({
      where: { profileId_syncType: { profileId, syncType: 'CONNECTIONS' } },
      update: { status: 'FAILED', error },
      create: { profileId, syncType: 'CONNECTIONS', status: 'FAILED', error },
    });

    // If session error, update profile connection status
    if (isSessionError) {
      await prisma.profile.update({
        where: { id: profileId },
        data: { linkedinConnectionStatus: 'REAUTH_REQUIRED' },
      });
    }
  } finally {
    // Always close the page to prevent resource leaks
    if (page) {
      await page.close().catch((err) => {
        console.error('Failed to close page:', err);
      });
    }
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

/**
 * Check for stuck syncs and mark them as TIMEOUT.
 * 
 * A sync is considered stuck if:
 * - Status is RUNNING
 * - Started more than 10 minutes ago
 * - No heartbeat in the last 5 minutes
 */
export async function checkStuckSyncs(): Promise<void> {
  const timeoutThreshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes
  const heartbeatThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes

  const stuckSyncs = await prisma.linkedInSync.findMany({
    where: {
      status: 'RUNNING',
      startedAt: { lt: timeoutThreshold },
      OR: [
        { heartbeatAt: null },
        { heartbeatAt: { lt: heartbeatThreshold } },
      ],
    },
  });

  for (const sync of stuckSyncs) {
    await prisma.linkedInSync.update({
      where: { id: sync.id },
      data: {
        status: 'TIMEOUT',
        error: 'Sync timed out - no heartbeat received within expected timeframe',
      },
    });

    // Also mark profile connection status as requiring re-auth
    await prisma.profile.update({
      where: { id: sync.profileId },
      data: { linkedinConnectionStatus: 'REAUTH_REQUIRED' },
    });
  }
}
