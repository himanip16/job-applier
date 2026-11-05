import cron from 'node-cron';
import { prisma } from './db.js';
import { findJobs } from '../discovery/findJobs.js';

/**
 * Scheduler for periodic job discovery.
 *
 * Runs findJobs for all profiles every 6 hours (at 0, 6, 12, 18, 24 UTC).
 * Can also be triggered manually via an admin endpoint.
 */

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Run job discovery for all active profiles.
 *
 * This function:
 * - Finds all profiles in the database
 * - Runs findJobs for each profile
 * - Logs results and errors
 */
export async function runScheduledJobDiscovery(): Promise<void> {
  const profiles = await prisma.profile.findMany({
    select: { id: true, email: true },
  });

  if (!profiles.length) {
    process.stdout.write('[scheduler] No profiles found - skipping scheduled job discovery\n');
    return;
  }

  process.stdout.write(`[scheduler] Starting job discovery for ${profiles.length} profile(s)\n`);

  for (const profile of profiles) {
    try {
      process.stdout.write(`[scheduler] Running job discovery for profile ${profile.email}\n`);
      const report = await findJobs(profile.id, {
        force: false,
        deepScoreTop: 20,
      });
      process.stdout.write(
        `[scheduler] Profile ${profile.email}: ${report.newLeads} new leads, ${report.deepScored} deep-scored\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[scheduler] Failed for profile ${profile.email}: ${(err as Error).message}\n`,
      );
    }
  }

  process.stdout.write('[scheduler] Scheduled job discovery completed\n');
}

/**
 * Start the scheduler.
 *
 * Schedules the job to run every 6 hours at 0, 6, 12, 18, 24 UTC.
 * Only one scheduler can be active at a time.
 */
export function startScheduler(): void {
  if (scheduledTask) {
    process.stdout.write('[scheduler] Scheduler already running - not starting again\n');
    return;
  }

  // Cron expression: run every 6 hours (0, 6, 12, 18, 24)
  const cronExpression = '0 */6 * * *';

  scheduledTask = cron.schedule(cronExpression, async () => {
    await runScheduledJobDiscovery();
  });

  process.stdout.write('[scheduler] Started - running every 6 hours (0, 6, 12, 18, 24 UTC)\n');
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    process.stdout.write('[scheduler] Stopped\n');
  }
}

/**
 * Check if the scheduler is currently running.
 */
export function isSchedulerRunning(): boolean {
  return scheduledTask !== null;
}
