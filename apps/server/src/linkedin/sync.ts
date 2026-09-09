import type { ContactRole, SyncType } from '../lib/db.js';
import { prisma } from '../lib/db.js';
import { openLinkedIn, linkedInPage } from './session.js';
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

  // Update sync status to running
  await prisma.linkedInSync.upsert({
    where: { profileId_syncType: { profileId, syncType: 'CONNECTIONS' } },
    update: { status: 'RUNNING', error: null },
    create: { profileId, syncType: 'CONNECTIONS', status: 'RUNNING' },
  });

  try {
    const page = await linkedInPage();
    
    // Navigate to connections page
    await openLinkedIn(page, 'https://www.linkedin.com/mynetwork/invite-connect/connections/');
    
    const connections = await readConnections(page, { onConnection: async (conn) => {
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
    } });

    if (connections.length === 0) {
      throw new Error(
        'No LinkedIn connections could be read. Check the connections page in the browser ' +
        'opened by Job Applier. If your connections are visible, the page reader needs updating.',
      );
    }
    if (errors.length) throw new Error(`Saved ${synced} connections, but some connections could not be saved. Retry sync to complete the import.`);

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
