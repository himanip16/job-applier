import { prisma } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Distributed lock implementation using PostgreSQL advisory locks + database leases.
 *
 * This hybrid approach provides:
 * - Fast acquisition via PostgreSQL advisory locks
 * - Lease expiration for stale-lock recovery
 * - Heartbeat mechanism for long-running jobs
 * - Automatic lock release on connection close (crash handling)
 * - Detailed logging for contention monitoring
 *
 * For the scheduler, we use a configurable lock key to ensure only one
 * instance can run scheduled job discovery at a time.
 */

/** Lock key for the scheduler job discovery (from config) */
const SCHEDULER_LOCK_KEY = config.schedulerLockKey;

/** Default lock acquisition timeout in milliseconds (from config) */
const DEFAULT_LOCK_TIMEOUT_MS = config.schedulerLockTimeoutMs;

/** Lease duration in milliseconds (from config) */
const LEASE_DURATION_MS = config.schedulerLeaseDurationMs;

/** Heartbeat interval in milliseconds (from config) */
const HEARTBEAT_INTERVAL_MS = config.schedulerHeartbeatIntervalMs;

/** Lease key for the scheduler job discovery */
const SCHEDULER_LEASE_KEY = 'job-discovery';

/** Instance identifier (hostname:pid) for tracking lease ownership */
const INSTANCE_ID = `${process.env.HOSTNAME || 'localhost'}:${process.pid}`;

/**
 * Acquire a database lease with expiration.
 *
 * @param leaseKey - The lease key (e.g., 'job-discovery')
 * @param durationMs - Lease duration in milliseconds
 * @returns true if lease was acquired, false if already held by another instance
 */
export async function acquireLease(
  leaseKey: string,
  durationMs: number = LEASE_DURATION_MS,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + durationMs);

  try {
    // First, clean up any expired leases for this key
    await prisma.schedulerLease.updateMany({
      where: {
        leaseKey,
        expiresAt: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });

    // Try to create a new lease (will fail if one already exists and is active)
    await prisma.schedulerLease.create({
      data: {
        leaseKey,
        instanceId: INSTANCE_ID,
        expiresAt,
        status: 'ACTIVE',
      },
    });

    logger.info(
      { leaseKey, instanceId: INSTANCE_ID, expiresAt },
      '[distributedLock] Lease acquired',
    );
    return true;
  } catch (err) {
    // Lease already exists, check if it's expired
    const existing = await prisma.schedulerLease.findUnique({
      where: { leaseKey },
    });

    if (!existing) {
      // Race condition: someone else deleted it, try again
      return acquireLease(leaseKey, durationMs);
    }

    if (existing.expiresAt < new Date()) {
      // Lease is expired, try to take it
      try {
        await prisma.schedulerLease.update({
          where: { leaseKey },
          data: {
            instanceId: INSTANCE_ID,
            acquiredAt: new Date(),
            expiresAt,
            heartbeatAt: new Date(),
            status: 'ACTIVE',
          },
        });

        logger.warn(
          { leaseKey, previousInstance: existing.instanceId },
          '[distributedLock] Acquired expired lease',
        );
        return true;
      } catch (updateErr) {
        // Someone else grabbed it first
        logger.warn(
          { leaseKey, holdingInstance: existing.instanceId },
          '[distributedLock] Lease held by another instance',
        );
        return false;
      }
    }

    // Lease is active and held by another instance
    logger.warn(
      { leaseKey, holdingInstance: existing.instanceId, expiresAt: existing.expiresAt },
      '[distributedLock] Lease held by another instance',
    );
    return false;
  }
}

/**
 * Release a database lease.
 *
 * @param leaseKey - The lease key to release
 */
export async function releaseLease(leaseKey: string): Promise<void> {
  try {
    await prisma.schedulerLease.updateMany({
      where: {
        leaseKey,
        instanceId: INSTANCE_ID,
        status: 'ACTIVE',
      },
      data: { status: 'RELEASED' },
    });

    logger.info({ leaseKey, instanceId: INSTANCE_ID }, '[distributedLock] Lease released');
  } catch (err) {
    logger.error({ err, leaseKey }, '[distributedLock] Failed to release lease');
  }
}

/**
 * Refresh a lease via heartbeat.
 *
 * @param leaseKey - The lease key to refresh
 * @param durationMs - New lease duration in milliseconds
 * @returns true if lease was refreshed, false if lease is no longer held
 */
export async function refreshLease(
  leaseKey: string,
  durationMs: number = LEASE_DURATION_MS,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + durationMs);

  try {
    const result = await prisma.schedulerLease.updateMany({
      where: {
        leaseKey,
        instanceId: INSTANCE_ID,
        status: 'ACTIVE',
      },
      data: {
        heartbeatAt: new Date(),
        expiresAt,
      },
    });

    if (result.count === 0) {
      // Lease no longer held by this instance
      logger.warn(
        { leaseKey, instanceId: INSTANCE_ID },
        '[distributedLock] Lease no longer held by this instance',
      );
      return false;
    }

    logger.debug({ leaseKey, expiresAt }, '[distributedLock] Lease refreshed');
    return true;
  } catch (err) {
    logger.error({ err, leaseKey }, '[distributedLock] Failed to refresh lease');
    return false;
  }
}

/**
 * Acquire a distributed lock with optional timeout.
 *
 * This uses a hybrid approach:
 * 1. PostgreSQL advisory lock for fast acquisition and crash handling
 * 2. Database lease for expiration and stale-lock recovery
 *
 * If the lock is already held by another process, this will wait up to
 * `timeoutMs` milliseconds for it to become available.
 *
 * @param lockKey - The advisory lock key (integer)
 * @param timeoutMs - Maximum time to wait for lock acquisition (default: 5 minutes)
 * @returns A lock release function that must be called when done
 * @throws Error if lock acquisition times out
 */
export async function acquireLock(
  lockKey: number = SCHEDULER_LOCK_KEY,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<() => Promise<void>> {
  const startTime = Date.now();
  const timeoutSeconds = Math.floor(timeoutMs / 1000);

  // Try to acquire the lock with timeout
  // pg_try_advisory_lock returns true if lock was acquired, false if not
  // pg_advisory_lock waits indefinitely
  // We'll use pg_try_advisory_lock in a loop with timeout

  while (Date.now() - startTime < timeoutMs) {
    const acquired = await prisma.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(${lockKey}::bigint) as acquired
    `;

    if (acquired[0]?.acquired) {
      // Advisory lock acquired successfully
      // Now try to acquire the database lease for expiration handling
      if (lockKey === SCHEDULER_LOCK_KEY) {
        const leaseAcquired = await acquireLease(SCHEDULER_LEASE_KEY);
        if (!leaseAcquired) {
          // Release advisory lock if lease acquisition failed
          await releaseLock(lockKey);
          throw new Error('Lease acquisition failed - another instance may hold the lease');
        }
      }

      const lockAcquireTime = Date.now() - startTime;
      logger.info(
        { lockKey, lockAcquireTimeMs: lockAcquireTime },
        '[distributedLock] Lock acquired',
      );

      return async () => {
        if (lockKey === SCHEDULER_LOCK_KEY) {
          await releaseLease(SCHEDULER_LEASE_KEY);
        }
        await releaseLock(lockKey);
      };
    }

    // Lock not available, wait a bit before retrying
    const elapsed = Date.now() - startTime;
    const remaining = timeoutMs - elapsed;
    const waitTime = Math.min(1000, remaining); // Wait up to 1 second per attempt

    if (remaining <= 0) {
      throw new Error(
        `Failed to acquire distributed lock ${lockKey} after ${timeoutMs}ms timeout`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  throw new Error(
    `Failed to acquire distributed lock ${lockKey} after ${timeoutMs}ms timeout`,
  );
}

/**
 * Release a distributed lock.
 *
 * @param lockKey - The advisory lock key to release
 */
export async function releaseLock(lockKey: number = SCHEDULER_LOCK_KEY): Promise<void> {
  await prisma.$queryRaw`
    SELECT pg_advisory_unlock(${lockKey}::bigint)
  `;
}

/**
 * Check if a lock is currently held by any session.
 *
 * Note: This checks if the lock is held by any session, not just the current one.
 * PostgreSQL advisory locks don't provide a way to check ownership directly.
 *
 * @param lockKey - The advisory lock key to check
 * @returns true if the lock is held, false otherwise
 */
export async function isLockHeld(lockKey: number = SCHEDULER_LOCK_KEY): Promise<boolean> {
  const result = await prisma.$queryRaw<Array<{ held: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory'
      AND objid = ${lockKey}::bigint
      AND pid <> pg_backend_pid()
    ) as held
  `;

  return result[0]?.held ?? false;
}

/**
 * Execute a function while holding a distributed lock with optional heartbeat.
 *
 * This is a convenience function that acquires the lock, runs the function,
 * and releases the lock when done (even if the function throws).
 *
 * For long-running operations, the lease is refreshed periodically via heartbeat.
 *
 * @param fn - The function to execute while holding the lock
 * @param lockKey - The advisory lock key (default: SCHEDULER_LOCK_KEY)
 * @param timeoutMs - Maximum time to wait for lock acquisition (default: 5 minutes)
 * @param heartbeatIntervalMs - Interval for refreshing the lease (default: from config)
 * @returns The result of the function
 */
export async function withLock<T>(
  fn: () => Promise<T>,
  lockKey: number = SCHEDULER_LOCK_KEY,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  const release = await acquireLock(lockKey, timeoutMs);
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatActive = true;

  // Start heartbeat for long-running operations
  if (lockKey === SCHEDULER_LOCK_KEY) {
    heartbeatTimer = setInterval(async () => {
      if (!heartbeatActive) return;

      const refreshed = await refreshLease(SCHEDULER_LEASE_KEY);
      if (!refreshed) {
        heartbeatActive = false;
        logger.error('[distributedLock] Lost lease during operation');
      }
    }, heartbeatIntervalMs);
  }

  try {
    return await fn();
  } finally {
    heartbeatActive = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    await release();
  }
}

/**
 * Acquire the scheduler lock specifically.
 *
 * This is a convenience function for the scheduler lock with its own key.
 *
 * @param timeoutMs - Maximum time to wait for lock acquisition (default: 5 minutes)
 * @returns A lock release function that must be called when done
 */
export async function acquireSchedulerLock(
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<() => Promise<void>> {
  return acquireLock(SCHEDULER_LOCK_KEY, timeoutMs);
}

/**
 * Execute a function while holding the scheduler lock.
 *
 * This is a convenience function for running scheduler operations with proper locking.
 *
 * @param fn - The function to execute while holding the scheduler lock
 * @param timeoutMs - Maximum time to wait for lock acquisition (default: 5 minutes)
 * @returns The result of the function
 */
export async function withSchedulerLock<T>(
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  return withLock(fn, SCHEDULER_LOCK_KEY, timeoutMs);
}
