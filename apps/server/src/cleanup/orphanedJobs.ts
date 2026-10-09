/**
 * Cleanup script to remove jobs that have no applications.
 *
 * When a profile is deleted, its applications are cascade-deleted, but the
 * associated Job records remain orphaned. This script cleans up those jobs.
 */

import { PrismaClient } from '../../../../generated/prisma/index.js';

const prisma = new PrismaClient();

export async function cleanupOrphanedJobs() {
  console.log('Finding orphaned jobs...');

  // Find jobs that have no applications
  const orphanedJobs = await prisma.job.findMany({
    where: {
      applications: {
        none: {},
      },
    },
    select: {
      id: true,
      url: true,
      company: true,
      title: true,
    },
  });

  console.log(`Found ${orphanedJobs.length} orphaned jobs`);

  if (orphanedJobs.length === 0) {
    console.log('No orphaned jobs to clean up');
    return { deleted: 0 };
  }

  // Delete orphaned jobs
  const result = await prisma.job.deleteMany({
    where: {
      applications: {
        none: {},
      },
    },
  });

  console.log(`Deleted ${result.count} orphaned jobs`);
  return { deleted: result.count };
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupOrphanedJobs()
    .then(() => {
      console.log('Cleanup complete');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Cleanup failed:', error);
      process.exit(1);
    });
}
