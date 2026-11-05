import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/lib/db.js';
import {
  acquireLock,
  releaseLock,
  isLockHeld,
  withLock,
  acquireLease,
  releaseLease,
  refreshLease,
} from '../src/lib/distributedLock.js';
import { resetTestDb } from './testDb.js';

describe('distributedLock', () => {
  beforeAll(async () => {
    await resetTestDb();
  });

  beforeEach(async () => {
    // Clean up any existing leases
    await prisma.schedulerLease.deleteMany();
    // Release any advisory locks
    await prisma.$queryRaw`SELECT pg_advisory_unlock_all()`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('PostgreSQL advisory locks', () => {
    it('should acquire and release a lock', async () => {
      const lockKey = 99999;
      const release = await acquireLock(lockKey, 5000);

      // Lock should be held
      const held = await isLockHeld(lockKey);
      expect(held).toBe(true);

      // Release the lock
      await release();

      // Lock should no longer be held
      const heldAfter = await isLockHeld(lockKey);
      expect(heldAfter).toBe(false);
    });

    it('should timeout when lock is held by another process', async () => {
      const lockKey = 99998;
      const release1 = await acquireLock(lockKey, 5000);

      // Try to acquire the same lock with a short timeout
      await expect(acquireLock(lockKey, 100)).rejects.toThrow('timeout');

      // Release the first lock
      await release1();

      // Now it should be available
      const release2 = await acquireLock(lockKey, 5000);
      await release2();
    });

    it('should execute function while holding lock', async () => {
      const lockKey = 99997;
      let executed = false;

      await withLock(async () => {
        executed = true;
        const held = await isLockHeld(lockKey);
        expect(held).toBe(true);
      }, lockKey, 5000);

      expect(executed).toBe(true);
    });

    it('should release lock even if function throws', async () => {
      const lockKey = 99996;

      await expect(
        withLock(async () => {
          const held = await isLockHeld(lockKey);
          expect(held).toBe(true);
          throw new Error('Test error');
        }, lockKey, 5000),
      ).rejects.toThrow('Test error');

      // Lock should be released despite the error
      const held = await isLockHeld(lockKey);
      expect(held).toBe(false);
    });
  });

  describe('Database leases', () => {
    it('should acquire a lease', async () => {
      const leaseKey = 'test-lease-1';
      const acquired = await acquireLease(leaseKey, 60000);

      expect(acquired).toBe(true);

      const lease = await prisma.schedulerLease.findUnique({
        where: { leaseKey },
      });

      expect(lease).toBeDefined();
      expect(lease?.status).toBe('ACTIVE');
      expect(lease?.leaseKey).toBe(leaseKey);

      await releaseLease(leaseKey);
    });

    it('should fail to acquire lease if already held', async () => {
      const leaseKey = 'test-lease-2';

      const acquired1 = await acquireLease(leaseKey, 60000);
      expect(acquired1).toBe(true);

      const acquired2 = await acquireLease(leaseKey, 60000);
      expect(acquired2).toBe(false);

      await releaseLease(leaseKey);
    });

    it('should release a lease', async () => {
      const leaseKey = 'test-lease-3';

      await acquireLease(leaseKey, 60000);
      await releaseLease(leaseKey);

      const lease = await prisma.schedulerLease.findUnique({
        where: { leaseKey },
      });

      expect(lease?.status).toBe('RELEASED');
    });

    it('should refresh a lease', async () => {
      const leaseKey = 'test-lease-4';

      await acquireLease(leaseKey, 60000);

      const originalLease = await prisma.schedulerLease.findUnique({
        where: { leaseKey },
      });

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      const refreshed = await refreshLease(leaseKey, 60000);
      expect(refreshed).toBe(true);

      const refreshedLease = await prisma.schedulerLease.findUnique({
        where: { leaseKey },
      });

      expect(refreshedLease?.heartbeatAt.getTime()).toBeGreaterThan(
        originalLease!.heartbeatAt.getTime(),
      );

      await releaseLease(leaseKey);
    });

    it('should allow acquiring an expired lease', async () => {
      const leaseKey = 'test-lease-5';

      // Acquire with very short expiry
      await acquireLease(leaseKey, 100);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Clean up expired leases
      await prisma.schedulerLease.updateMany({
        where: {
          leaseKey,
          expiresAt: { lt: new Date() },
        },
        data: { status: 'EXPIRED' },
      });

      // Should be able to acquire now
      const acquired = await acquireLease(leaseKey, 60000);
      expect(acquired).toBe(true);

      await releaseLease(leaseKey);
    });
  });

  describe('Hybrid locking (advisory + lease)', () => {
    it('should acquire both advisory lock and lease', async () => {
      const lockKey = 99995;
      const leaseKey = 'test-lease-6';

      const release = await acquireLock(lockKey, 5000);

      // Check advisory lock
      const held = await isLockHeld(lockKey);
      expect(held).toBe(true);

      // Check lease
      const lease = await prisma.schedulerLease.findUnique({
        where: { leaseKey },
      });

      expect(lease).toBeDefined();
      expect(lease?.status).toBe('ACTIVE');

      await release();

      // Both should be released
      const heldAfter = await isLockHeld(lockKey);
      expect(heldAfter).toBe(false);

      const leaseAfter = await prisma.schedulerLease.findUnique({
        where: { leaseKey },
      });
      expect(leaseAfter?.status).toBe('RELEASED');
    });

    it('should fail if lease acquisition fails', async () => {
      const lockKey = 99994;
      const leaseKey = 'test-lease-7';

      // Pre-acquire the lease
      await acquireLease(leaseKey, 60000);

      // Try to acquire the full lock (should fail because lease is held)
      await expect(acquireLock(lockKey, 5000)).rejects.toThrow('Lease acquisition failed');

      // Advisory lock should not be held
      const held = await isLockHeld(lockKey);
      expect(held).toBe(false);

      await releaseLease(leaseKey);
    });
  });

  describe('Concurrent instance simulation', () => {
    it('should prevent concurrent execution', async () => {
      const lockKey = 99993;
      const results: number[] = [];

      // Simulate instance 1
      const instance1 = withLock(async () => {
        results.push(1);
        await new Promise((resolve) => setTimeout(resolve, 200));
        results.push(2);
      }, lockKey, 5000);

      // Simulate instance 2 trying to run concurrently
      const instance2 = withLock(async () => {
        results.push(3);
      }, lockKey, 100); // Short timeout

      // Instance 2 should timeout
      await expect(instance2).rejects.toThrow('timeout');

      // Instance 1 should complete
      await instance1;

      // Only instance 1's operations should have run
      expect(results).toEqual([1, 2]);
    });

    it('should allow sequential execution', async () => {
      const lockKey = 99992;
      const results: number[] = [];

      // Instance 1
      await withLock(async () => {
        results.push(1);
      }, lockKey, 5000);

      // Instance 2
      await withLock(async () => {
        results.push(2);
      }, lockKey, 5000);

      expect(results).toEqual([1, 2]);
    });
  });

  describe('Stale lock recovery', () => {
    it('should recover from expired lease', async () => {
      const lockKey = 99991;
      const leaseKey = 'test-lease-8';

      // Acquire lock with short lease
      const release = await acquireLock(lockKey, 5000);

      // Manually expire the lease in the database
      await prisma.schedulerLease.update({
        where: { leaseKey },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // Release the lock
      await release();

      // Clean up expired leases
      await prisma.schedulerLease.updateMany({
        where: {
          leaseKey,
          expiresAt: { lt: new Date() },
        },
        data: { status: 'EXPIRED' },
      });

      // Should be able to acquire again
      const release2 = await acquireLock(lockKey, 5000);
      const lease = await prisma.schedulerLease.findUnique({
        where: { leaseKey },
      });

      expect(lease?.status).toBe('ACTIVE');

      await release2();
    });
  });
});
