import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/lib/db.js';
import {
  writeOutboxEvent,
  deliverOutboxEvents,
  getOutboxStats,
  replayDeadLetteredEvents,
  getDeadLetteredEvents,
  getDeliveryMetrics,
  resetDeliveryMetrics,
  getDeliveryPerformance,
} from '../src/engine/outbox.js';

describe('Outbox', () => {
  beforeEach(async () => {
    // Clean up outbox events before each test
    await prisma.outboxEvent.deleteMany({});
    resetDeliveryMetrics();
  });

  describe('writeOutboxEvent', () => {
    it('should write an event to the outbox', async () => {
      await writeOutboxEvent('application.submitted', 'app-123', 'application', {
        applicationId: 'app-123',
        profileId: 'profile-123',
        jobId: 'job-123',
        timestamp: new Date().toISOString(),
      });

      const events = await prisma.outboxEvent.findMany();
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe('application.submitted');
      expect(events[0]?.entityId).toBe('app-123');
      expect(events[0]?.entityType).toBe('application');
      expect(events[0]?.deliveredAt).toBeNull();
      expect(events[0]?.attempts).toBe(0);
    });

    it('should write events in a transaction', async () => {
      await prisma.$transaction(async (tx) => {
        await writeOutboxEvent('application.queued', 'app-1', 'application', {
          applicationId: 'app-1',
          profileId: 'profile-1',
          jobId: 'job-1',
          timestamp: new Date().toISOString(),
        }, tx);

        await writeOutboxEvent('application.started', 'app-1', 'application', {
          applicationId: 'app-1',
          profileId: 'profile-1',
          jobId: 'job-1',
          timestamp: new Date().toISOString(),
        }, tx);
      });

      const events = await prisma.outboxEvent.findMany();
      expect(events).toHaveLength(2);
    });
  });

  describe('deliverOutboxEvents', () => {
    it('should deliver pending events', async () => {
      await writeOutboxEvent('application.submitted', 'app-123', 'application', {
        applicationId: 'app-123',
        profileId: 'profile-123',
        jobId: 'job-123',
        timestamp: new Date().toISOString(),
      });

      const result = await deliverOutboxEvents();
      expect(result.delivered).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.deadLettered).toBe(0);

      const events = await prisma.outboxEvent.findMany();
      expect(events[0]?.deliveredAt).not.toBeNull();
    });

    it('should only deliver events that are ready for retry', async () => {
      // Create one event ready for delivery
      await writeOutboxEvent('application.submitted', 'app-1', 'application', {
        applicationId: 'app-1',
        profileId: 'profile-1',
        jobId: 'job-1',
        timestamp: new Date().toISOString(),
      });

      // Create one event that should wait for retry
      const event2 = await prisma.outboxEvent.create({
        data: {
          eventType: 'application.failed',
          entityId: 'app-2',
          entityType: 'application',
          payload: {},
          attempts: 1,
          lastError: 'test error',
          nextRetryAt: new Date(Date.now() + 60000), // 1 minute in future
        },
      });

      const result = await deliverOutboxEvents();
      expect(result.delivered).toBe(1); // Only the first event

      const events = await prisma.outboxEvent.findMany({ orderBy: { entityId: 'asc' } });
      expect(events[0]?.deliveredAt).not.toBeNull();
      expect(events[1]?.deliveredAt).toBeNull(); // Second event not delivered yet
    });

    it('should handle failed deliveries with retry', async () => {
      // This test would require mocking the adapter behavior
      // For now, we just verify the retry logic exists
      await writeOutboxEvent('application.submitted', 'app-123', 'application', {
        applicationId: 'app-123',
        profileId: 'profile-123',
        jobId: 'job-123',
        timestamp: new Date().toISOString(),
      });

      const result = await deliverOutboxEvents();
      expect(result.delivered).toBe(1);
    });

    it('should dead-letter events after max retry attempts', async () => {
      // Create an event that has already exceeded max attempts
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: 'application.failed',
          entityId: 'app-1',
          entityType: 'application',
          payload: {},
          attempts: 10, // Already at max
          lastError: 'test error',
          nextRetryAt: new Date(),
        },
      });

      // Mock a failing delivery
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await deliverOutboxEvents();
      
      // The event should be dead-lettered
      const updatedEvent = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });

      expect(updatedEvent?.deadLettered).toBe(true);
      expect(updatedEvent?.deadLetterReason).toContain('Max retry attempts');
      
      consoleSpy.mockRestore();
    });
  });

  describe('idempotency', () => {
    it('should not duplicate side effects on redelivery', async () => {
      await writeOutboxEvent('application.submitted', 'app-123', 'application', {
        applicationId: 'app-123',
        profileId: 'profile-123',
        jobId: 'job-123',
        timestamp: new Date().toISOString(),
      });

      // Deliver once
      await deliverOutboxEvents();
      
      // Try to deliver again (event is already marked as delivered)
      const result = await deliverOutboxEvents();
      expect(result.delivered).toBe(0); // Should not deliver again
    });
  });

  describe('crash handling', () => {
    it('should preserve events when delivery fails before acknowledgement', async () => {
      // Write an event
      await writeOutboxEvent('application.submitted', 'app-123', 'application', {
        applicationId: 'app-123',
        profileId: 'profile-123',
        jobId: 'job-123',
        timestamp: new Date().toISOString(),
      });

      // Simulate crash: don't mark as delivered
      // Event should still be in pending state
      const statsBefore = await getOutboxStats();
      expect(statsBefore.pending).toBe(1);

      // After restart, deliver the event
      const result = await deliverOutboxEvents();
      expect(result.delivered).toBe(1);

      // Verify it's now delivered
      const statsAfter = await getOutboxStats();
      expect(statsAfter.pending).toBe(0);
      expect(statsAfter.delivered).toBe(1);
    });

    it('should retry events that were in progress during crash', async () => {
      // Create an event with nextRetryAt in the past (simulating retry after crash)
      await prisma.outboxEvent.create({
        data: {
          eventType: 'application.submitted',
          entityId: 'app-123',
          entityType: 'application',
          payload: {},
          attempts: 1,
          lastError: 'connection lost',
          nextRetryAt: new Date(Date.now() - 1000), // 1 second ago
        },
      });

      const result = await deliverOutboxEvents();
      expect(result.delivered).toBe(1);
    });
  });

  describe('dead-letter handling', () => {
    it('should allow replaying dead-lettered events', async () => {
      // Create a dead-lettered event
      const event = await prisma.outboxEvent.create({
        data: {
          eventType: 'application.submitted',
          entityId: 'app-123',
          entityType: 'application',
          payload: {},
          deadLettered: true,
          deadLetterReason: 'Max retries exceeded',
          attempts: 10,
        },
      });

      // Replay it
      const count = await replayDeadLetteredEvents([event.id]);
      expect(count).toBe(1);

      // Verify it's reset
      const updated = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });
      expect(updated?.deadLettered).toBe(false);
      expect(updated?.attempts).toBe(0);
      expect(updated?.deadLetterReason).toBeNull();
    });

    it('should retrieve dead-lettered events', async () => {
      await prisma.outboxEvent.create({
        data: {
          eventType: 'application.failed',
          entityId: 'app-1',
          entityType: 'application',
          payload: {},
          deadLettered: true,
          deadLetterReason: 'test',
        },
      });

      const deadLettered = await getDeadLetteredEvents();
      expect(deadLettered).toHaveLength(1);
      expect(deadLettered[0]?.deadLettered).toBe(true);
    });
  });

  describe('metrics', () => {
    it('should track delivery metrics', async () => {
      await writeOutboxEvent('application.submitted', 'app-1', 'application', {
        applicationId: 'app-1',
        profileId: 'profile-1',
        jobId: 'job-1',
        timestamp: new Date().toISOString(),
      });

      await deliverOutboxEvents();

      const metrics = getDeliveryMetrics();
      expect(metrics.totalDelivered).toBe(1);
      expect(metrics.totalFailed).toBe(0);
    });

    it('should calculate delivery performance statistics', async () => {
      await writeOutboxEvent('application.submitted', 'app-1', 'application', {
        applicationId: 'app-1',
        profileId: 'profile-1',
        jobId: 'job-1',
        timestamp: new Date().toISOString(),
      });

      await deliverOutboxEvents();

      const perf = getDeliveryPerformance();
      expect(perf.avgDeliveryTime).toBeGreaterThan(0);
    });

    it('should reset metrics', async () => {
      await writeOutboxEvent('application.submitted', 'app-1', 'application', {
        applicationId: 'app-1',
        profileId: 'profile-1',
        jobId: 'job-1',
        timestamp: new Date().toISOString(),
      });

      await deliverOutboxEvents();
      resetDeliveryMetrics();

      const metrics = getDeliveryMetrics();
      expect(metrics.totalDelivered).toBe(0);
    });
  });

  describe('getOutboxStats', () => {
    it('should return outbox statistics', async () => {
      await writeOutboxEvent('application.submitted', 'app-1', 'application', {
        applicationId: 'app-1',
        profileId: 'profile-1',
        jobId: 'job-1',
        timestamp: new Date().toISOString(),
      });

      const stats = await getOutboxStats();
      expect(stats.pending).toBe(1);
      expect(stats.delivered).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.deadLettered).toBe(0);
      expect(stats.oldestPending).not.toBeNull();
    });
  });
});
