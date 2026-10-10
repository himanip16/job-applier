import type { Page } from 'playwright';
import type { ContactRole, SyncType } from '../lib/db.js';
import { prisma } from '../lib/db.js';
import { openLinkedIn, linkedInPage, hasLinkedInSession } from './session.js';
import { readConnections } from './connectionReader.js';
export { readConnections } from './connectionReader.js';
import { classifyRole, isOutreachTarget } from './roles.js';

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

  if (!profile) throw new Error('Profile not found.');
  if (profile.linkedinConnectionStatus !== 'CONNECTED') {
    // A browser already signed in to LinkedIn is connected, whatever the stored
    // status says - it predates the connect button for anyone set up before it.
    if (!(await hasLinkedInSession())) {
      throw new Error('LinkedIn is not connected. Please connect your LinkedIn account first.');
    }
    await prisma.profile.update({ where: { id: profileId }, data: { linkedinConnectionStatus: 'CONNECTED' } });
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
    
    // Navigate to connections page
    await openLinkedIn(page, 'https://www.linkedin.com/mynetwork/invite-connect/connections/');
    
    const connections = await readConnections(page, { onConnection: async (conn) => {
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
    } });

    if (connections.length === 0) {
      throw new Error(
        'No LinkedIn connections could be read. Check the connections page in the browser ' +
        'opened by Job Applier. If your connections are visible, the page reader needs updating.',
      );
    }
    if (errors.length) throw new Error(`Saved ${synced} connections, but some connections could not be saved. Retry sync to complete the import.`);

    // Closed only on success: a failed sync leaves the page open to look at.
    await page.close();

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
    
    // Only a lost session needs you to sign in again; an unreadable page does not.
    const isSessionError = /sign[- ]?in|signed out|challenge|authwall|checkpoint/i.test(error);
    
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
