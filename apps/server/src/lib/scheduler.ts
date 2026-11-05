import cron from 'node-cron';
import { prisma } from './db.js';
import { findJobs } from '../discovery/findJobs.js';
import { config } from './config.js';
import { enqueue } from '../engine/queue.js';
import { adapterFor } from '../ats/registry.js';
import { learnFromDecision } from '../discovery/signalLearning.js';
import { API_SOURCES } from '../discovery/sources/index.js';
import { claimLeadForApplication, markExpiredLeads } from '../engine/applicationReliability.js';
import { validateApplicationEligibility } from '../engine/applicationValidation.js';
import { writeOutboxEvent } from '../engine/outbox.js';
import { bestEffort, BestEffortError, RecoverableError, CriticalError } from './errorHandler.js';
import { withSchedulerLock, isLockHeld } from './distributedLock.js';
import { logger, createProfileLogger, createApplicationLogger } from './logger.js';

/**
 * Scheduler for periodic job discovery and auto-apply.
 *
 * Runs findJobs for all profiles every 6 hours (at 0, 6, 12, 18, 24 UTC).
 * If auto-apply is enabled, automatically applies to high-scoring discovered jobs.
 * Can also be triggered manually via an admin endpoint.
 */

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let isRunning = false;

/** The boards the app has form adapters for (can auto-apply). */
const AUTO_APPLY_BOARDS = new Set(API_SOURCES.map((s) => s.id));

/**
 * Run job discovery for all active profiles.
 *
 * This function:
 * - Acquires a distributed lock to prevent concurrent execution across multiple instances
 * - Prevents overlapping execution (in-memory check as a fast path)
 * - Finds all profiles in the database
 * - Runs findJobs for each profile
 * - Marks expired leads
 * - If auto-apply is enabled, creates and queues applications for high-scoring jobs
 * - Logs results and errors
 */
export async function runScheduledJobDiscovery(): Promise<void> {
  // Fast path: check if already running in this process
  if (isRunning) {
    logger.warn('[scheduler] Already running (in-memory check) - skipping this invocation');
    return;
  }

  // If distributed locking is enabled, use it
  if (config.schedulerLockEnabled) {
    // Check if lock is held by another instance before attempting acquisition
    const lockHeld = await isLockHeld();
    if (lockHeld) {
      logger.warn('[scheduler] Lock held by another instance - skipping this invocation');
      return;
    }

    logger.info('[scheduler] Acquiring distributed lock...');
    const lockAcquireStart = Date.now();

    try {
      await withSchedulerLock(async () => {
        const lockAcquireTime = Date.now() - lockAcquireStart;
        logger.info({ lockAcquireTimeMs: lockAcquireTime }, '[scheduler] Lock acquired');

        // Check again after acquiring lock (race condition check)
        if (isRunning) {
          logger.warn('[scheduler] Already running after lock acquisition - skipping');
          return;
        }

        await runJobDiscoveryInternal();
      }, config.schedulerLockTimeoutMs);
    } catch (err) {
      const errorMessage = (err as Error).message;
      if (errorMessage.includes('timeout')) {
        logger.error(
          { timeoutMs: config.schedulerLockTimeoutMs },
          '[scheduler] Lock acquisition timeout - another instance may be holding the lock',
        );
      } else {
        logger.error({ err }, '[scheduler] Lock error');
      }
      return;
    }
  } else {
    // Distributed locking disabled - use in-memory check only
    isRunning = true;
    try {
      await runJobDiscoveryInternal();
    } finally {
      isRunning = false;
    }
  }
}

/**
 * Internal implementation of job discovery (assumes lock is already held).
 */
async function runJobDiscoveryInternal(): Promise<void> {
  isRunning = true;
  try {
    const profiles = await prisma.profile.findMany({
      select: { id: true, email: true },
    });

    if (!profiles.length) {
      logger.info('[scheduler] No profiles found - skipping scheduled job discovery');
      return;
    }

    logger.info({ profileCount: profiles.length }, '[scheduler] Starting job discovery');

    // Mark expired leads first
    const expiredCount = await markExpiredLeads();
    if (expiredCount > 0) {
      logger.info({ expiredCount }, '[scheduler] Marked expired leads');
    }

    for (const profile of profiles) {
      const profileLogger = createProfileLogger(profile.id, profile.email);
      try {
        profileLogger.info('[scheduler] Running job discovery');
        const report = await findJobs(profile.id, {
          force: false,
          deepScoreTop: 20,
        });
        profileLogger.info(
          { newLeads: report.newLeads, deepScored: report.deepScored },
          '[scheduler] Job discovery completed',
        );

        // Auto-apply to high-scoring jobs if enabled
        if (config.autoApplyEnabled) {
          await autoApplyToHighScoringJobs(profile.id, profile.email);
        }
      } catch (err) {
        profileLogger.error({ err }, '[scheduler] Job discovery failed');
      }
    }

    logger.info('[scheduler] Scheduled job discovery completed');
  } finally {
    isRunning = false;
  }
}

/**
 * Auto-apply to high-scoring discovered jobs.
 *
 * Finds NEW leads that:
 * - Have a score >= AUTO_APPLY_MIN_SCORE
 * - Are on boards we can auto-apply to
 * - Have not already been applied to
 * - Limits to AUTO_APPLY_MAX_PER_RUN per run
 *
 * Creates applications and enqueues them for processing.
 */
async function autoApplyToHighScoringJobs(profileId: string, email: string): Promise<void> {
  const profileLogger = createProfileLogger(profileId, email);
  profileLogger.info('[scheduler] Auto-apply enabled');

  // Find NEW leads that meet criteria
  const leads = await prisma.jobLead.findMany({
    where: {
      profileId,
      status: 'NEW',
      score: { gte: config.autoApplyMinScore },
      ats: { in: [...AUTO_APPLY_BOARDS] },
    },
    orderBy: { score: 'desc' },
    take: config.autoApplyMaxPerRun,
    select: {
      id: true,
      url: true,
      title: true,
      companyName: true,
      location: true,
      descriptionText: true,
      score: true,
      ats: true,
    },
  });

  if (!leads.length) {
    profileLogger.info(
      { minScore: config.autoApplyMinScore },
      '[scheduler] No leads meeting auto-apply criteria',
    );
    return;
  }

  profileLogger.info(
    { leadCount: leads.length, minScore: config.autoApplyMinScore },
    '[scheduler] Found leads meeting auto-apply criteria',
  );

  let appliedCount = 0;
  for (const lead of leads) {
    const appLogger = createApplicationLogger(undefined, undefined, lead.companyName, lead.ats);
    try {
      // Run comprehensive validation checks before auto-apply
      const eligibilityCheck = await validateApplicationEligibility(
        profileId,
        {
          url: lead.url,
          company: lead.companyName,
          title: lead.title,
          location: lead.location,
          descriptionText: lead.descriptionText,
          workMode: undefined,
        },
        lead.id,
      );

      if (!eligibilityCheck.allPassed) {
        const failures = eligibilityCheck.results.filter((r) => !r.passed);
        appLogger.warn(
          { title: lead.title, failures: failures.map((f) => ({ category: f.category, reason: f.reason })) },
          '[scheduler] Skipping lead - validation failed',
        );

        // Record the auto-apply decision (rejected)
        await prisma.autoApplyDecision.create({
          data: {
            profileId,
            leadId: lead.id,
            approved: false,
            score: lead.score,
            reason: `Validation failed: ${failures.map((f) => f.reason).join('; ')}`,
            failures: failures.map((f) => ({ category: f.category, reason: f.reason })),
            source: 'SCHEDULER',
            dryRun: eligibilityCheck.isDryRun,
          },
        });

        continue;
      }

      // Atomically claim the lead to prevent race conditions
      const claim = await claimLeadForApplication(profileId, lead.id);
      if (!claim.success) {
        appLogger.warn(
          { title: lead.title, reason: claim.reason },
          '[scheduler] Skipping lead - claim failed',
        );
        continue;
      }

      // Create or update job record
      const adapter = adapterFor(lead.url);
      const job = await prisma.job.upsert({
        where: { url: lead.url },
        create: {
          url: lead.url,
          ats: adapter.id,
          company: lead.companyName,
          title: lead.title,
          location: lead.location,
          descriptionText: lead.descriptionText,
        },
        update: { descriptionText: lead.descriptionText ?? undefined },
      });

      // Create application with requiresReview=false for auto-apply
      const application = await prisma.application.upsert({
        where: { profileId_jobId: { profileId, jobId: job.id } },
        create: {
          profileId,
          jobId: job.id,
          requiresReview: false, // Auto-apply: no review gate
          writeCoverLetter: false,
          dryRun: eligibilityCheck.isDryRun,
        },
        update: {
          status: 'QUEUED',
          blockedReason: null,
          requiresReview: false,
          writeCoverLetter: false,
          dryRun: eligibilityCheck.isDryRun,
        },
      });

      // Update lead status
      await prisma.jobLead.update({
        where: { id: lead.id },
        data: {
          status: 'SHORTLISTED',
          applicationId: application.id,
          decidedAt: new Date(),
        },
      });

      // Learn from this decision
      await bestEffort(
        () => learnFromDecision({
          profileId,
          job: {
            title: lead.title,
            descriptionText: lead.descriptionText ?? '',
            location: lead.location ?? undefined,
          },
          accepted: true,
          reason: 'Auto-applied by scheduler',
        }),
        { operation: 'learnFromDecision', entityId: profileId, jobId: job.id },
      );

      // Enqueue for processing
      enqueue(application.id);

      // Record the auto-apply decision (approved)
      await prisma.autoApplyDecision.create({
        data: {
          profileId,
          leadId: lead.id,
          jobId: job.id,
          applicationId: application.id,
          approved: true,
          score: lead.score,
          reason: 'Auto-applied by scheduler - all validations passed',
          source: 'SCHEDULER',
          dryRun: eligibilityCheck.isDryRun,
        },
      });

      appliedCount++;
      appLogger.info(
        { title: lead.title, score: lead.score, applicationId: application.id, dryRun: eligibilityCheck.isDryRun },
        '[scheduler] Auto-applied to lead',
      );
    } catch (err) {
      appLogger.error(
        { err, title: lead.title },
        '[scheduler] Failed to auto-apply to lead',
      );
    }
  }

  profileLogger.info({ appliedCount }, '[scheduler] Auto-apply completed');
}

/**
 * Start the scheduler.
 *
 * Schedules the job to run every 6 hours at 0, 6, 12, 18, 24 UTC.
 * Only one scheduler can be active at a time.
 */
export function startScheduler(): void {
  if (scheduledTask) {
    logger.warn('[scheduler] Scheduler already running - not starting again');
    return;
  }

  // Cron expression: run every 6 hours (0, 6, 12, 18, 24 UTC)
  // Using UTC to ensure consistent timing across all timezones
  const cronExpression = '0 */6 * * *';

  scheduledTask = cron.schedule(cronExpression, async () => {
    await runScheduledJobDiscovery();
  }, {
    timezone: 'UTC', // Explicitly set UTC for consistent scheduling
  });

  logger.info('[scheduler] Started - running every 6 hours (0, 6, 12, 18, 24 UTC)');
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[scheduler] Stopped');
  }
}

/**
 * Check if the scheduler is currently running.
 */
export function isSchedulerRunning(): boolean {
  return scheduledTask !== null;
}
