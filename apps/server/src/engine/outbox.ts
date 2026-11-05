import { prisma, type Prisma } from '../lib/db.js';

/**
 * Transactional outbox pattern for reliable event delivery.
 *
 * Events are written to the outbox in the same transaction as the state change
 * that produced them. A background worker then reads and delivers these events.
 * This guarantees that no event is lost if the process crashes between the state
 * change and event delivery.
 */

/**
 * Retry configuration for outbox event delivery.
 */
const RETRY_CONFIG = {
  maxAttempts: 10,
  initialDelayMs: 1000, // 1 second
  maxDelayMs: 5 * 60 * 1000, // 5 minutes
  backoffMultiplier: 2,
};

/**
 * Delivery metrics tracker.
 */
interface DeliveryMetrics {
  totalDelivered: number;
  totalFailed: number;
  totalDeadLettered: number;
  totalRetried: number;
  deliveryTimes: number[]; // in milliseconds
  lastReset: Date;
}

const metrics: DeliveryMetrics = {
  totalDelivered: 0,
  totalFailed: 0,
  totalDeadLettered: 0,
  totalRetried: 0,
  deliveryTimes: [],
  lastReset: new Date(),
};

/**
 * Get current delivery metrics.
 */
export function getDeliveryMetrics(): DeliveryMetrics {
  return { ...metrics };
}

/**
 * Reset delivery metrics.
 */
export function resetDeliveryMetrics(): void {
  metrics.totalDelivered = 0;
  metrics.totalFailed = 0;
  metrics.totalDeadLettered = 0;
  metrics.totalRetried = 0;
  metrics.deliveryTimes = [];
  metrics.lastReset = new Date();
}

/**
 * Record a successful delivery.
 */
function recordDelivery(durationMs: number): void {
  metrics.totalDelivered++;
  metrics.deliveryTimes.push(durationMs);
  // Keep only last 1000 delivery times to prevent memory growth
  if (metrics.deliveryTimes.length > 1000) {
    metrics.deliveryTimes.shift();
  }
}

/**
 * Record a failed delivery.
 */
function recordFailure(): void {
  metrics.totalFailed++;
}

/**
 * Record a dead-lettered event.
 */
function recordDeadLetter(): void {
  metrics.totalDeadLettered++;
}

/**
 * Record a retry.
 */
function recordRetry(): void {
  metrics.totalRetried++;
}

/**
 * Get delivery performance statistics.
 */
export function getDeliveryPerformance(): {
  avgDeliveryTime: number;
  p50DeliveryTime: number;
  p95DeliveryTime: number;
  p99DeliveryTime: number;
} {
  if (metrics.deliveryTimes.length === 0) {
    return {
      avgDeliveryTime: 0,
      p50DeliveryTime: 0,
      p95DeliveryTime: 0,
      p99DeliveryTime: 0,
    };
  }

  const sorted = [...metrics.deliveryTimes].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sorted.length > 0 ? sum / sorted.length : 0;

  const p50Index = Math.floor(sorted.length * 0.5);
  const p95Index = Math.floor(sorted.length * 0.95);
  const p99Index = Math.floor(sorted.length * 0.99);

  return {
    avgDeliveryTime: avg,
    p50DeliveryTime: sorted[p50Index] ?? 0,
    p95DeliveryTime: sorted[p95Index] ?? 0,
    p99DeliveryTime: sorted[p99Index] ?? 0,
  };
}

/**
 * Calculate next retry time using exponential backoff with jitter.
 */
function calculateNextRetry(attempts: number): Date {
  const delay = Math.min(
    RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempts),
    RETRY_CONFIG.maxDelayMs
  );
  // Add jitter (±25%) to avoid thundering herd
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  const nextRetry = new Date(Date.now() + delay + jitter);
  return nextRetry;
}

export type OutboxEventType =
  | 'application.queued'
  | 'application.started'
  | 'application.submitted'
  | 'application.failed'
  | 'application.retried'
  | 'application.dead_lettered'
  | 'lead.claimed'
  | 'lead.expired';

/**
 * Payload contracts for each event type.
 * These provide type safety and documentation for event payloads.
 */
export interface OutboxPayloads {
  'application.queued': {
    applicationId: string;
    profileId: string;
    jobId: string;
    timestamp: string;
  };
  'application.started': {
    applicationId: string;
    profileId: string;
    jobId: string;
    timestamp: string;
  };
  'application.submitted': {
    applicationId: string;
    profileId: string;
    jobId: string;
    confirmation?: string;
    timestamp: string;
  };
  'application.failed': {
    applicationId: string;
    profileId: string;
    jobId: string;
    error: string;
    timestamp: string;
  };
  'application.retried': {
    applicationId: string;
    profileId: string;
    jobId: string;
    retryCount: number;
    timestamp: string;
  };
  'application.dead_lettered': {
    applicationId: string;
    profileId: string;
    jobId: string;
    reason: string;
    timestamp: string;
  };
  'lead.claimed': {
    leadId: string;
    profileId: string;
    jobUrl: string;
    timestamp: string;
  };
  'lead.expired': {
    leadId: string;
    profileId: string;
    jobUrl: string;
    timestamp: string;
  };
}

export type OutboxPayload = OutboxPayloads[OutboxEventType];

/**
 * Write an event to the outbox in a transaction.
 *
 * This should be called within a prisma.$transaction() to ensure atomicity.
 */
export async function writeOutboxEvent(
  eventType: OutboxEventType,
  entityId: string,
  entityType: string,
  payload: OutboxPayload,
  tx?: Parameters<Parameters<typeof prisma['$transaction']>[0]>[0],
): Promise<void> {
  const db = tx || prisma;

  await db.outboxEvent.create({
    data: {
      eventType,
      entityId,
      entityType,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

/**
 * Deliver pending outbox events.
 *
 * Reads undelivered events that are ready for retry and delivers them.
 * Events are marked as delivered only after successful delivery.
 * Implements exponential backoff with jitter and dead-letter handling.
 * This function should be called periodically by a background worker.
 */
export async function deliverOutboxEvents(): Promise<{
  delivered: number;
  failed: number;
  deadLettered: number;
}> {
  const now = new Date();

  // Fetch events that are:
  // - Not yet delivered
  // - Not dead-lettered
  // - Either never attempted, or ready for retry (nextRetryAt <= now)
  const events = await prisma.outboxEvent.findMany({
    where: {
      deliveredAt: null,
      deadLettered: false,
      OR: [
        { nextRetryAt: null }, // Never attempted
        { nextRetryAt: { lte: now } }, // Ready for retry
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 100, // Batch size
  });

  let delivered = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const event of events) {
    const startTime = Date.now();
    try {
      await deliverEvent(event);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { deliveredAt: new Date() },
      });
      const duration = Date.now() - startTime;
      recordDelivery(duration);
      delivered++;
    } catch (err) {
      const errorMessage = (err as Error).message;
      const newAttempts = event.attempts + 1;

      recordFailure();
      if (newAttempts > 1) {
        recordRetry();
      }

      // Check if we've exceeded max attempts
      if (newAttempts >= RETRY_CONFIG.maxAttempts) {
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts: newAttempts,
            lastError: errorMessage,
            deadLettered: true,
            deadLetterReason: `Max retry attempts (${RETRY_CONFIG.maxAttempts}) exceeded. Last error: ${errorMessage}`,
          },
        });
        recordDeadLetter();
        deadLettered++;
      } else {
        // Calculate next retry time with exponential backoff
        const nextRetryAt = calculateNextRetry(newAttempts);

        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts: newAttempts,
            lastError: errorMessage,
            nextRetryAt,
          },
        });
        failed++;
      }
    }
  }

  return { delivered, failed, deadLettered };
}

/**
 * Delivery adapter interface.
 *
 * Each adapter handles delivery to a specific destination (webhooks, analytics, etc.).
 * Adapters should be idempotent - receiving the same event multiple times should
 * not cause duplicate side effects.
 */
interface DeliveryAdapter {
  name: string;
  canHandle(eventType: string): boolean;
  deliver(event: {
    id: string;
    eventType: string;
    payload: unknown;
    entityId: string;
    entityType: string;
  }): Promise<void>;
}

/**
 * Idempotency key store.
 *
 * Tracks which events have been processed to prevent duplicate side effects.
 * This is a simple in-memory store; for production, use Redis or a database table.
 */
const processedEvents = new Set<string>();

/**
 * Check if an event has already been processed.
 */
function isEventProcessed(eventId: string): boolean {
  return processedEvents.has(eventId);
}

/**
 * Mark an event as processed.
 */
function markEventProcessed(eventId: string): void {
  processedEvents.add(eventId);
}

/**
 * Clean up old processed event entries to prevent memory leaks.
 * Runs periodically to remove entries older than the specified TTL.
 */
function cleanupProcessedEvents(ttlMs: number = 24 * 60 * 60 * 1000): void {
  // In a real implementation with Redis, this would use TTL.
  // For in-memory, we just clear everything periodically.
  if (processedEvents.size > 10000) {
    processedEvents.clear();
  }
}

/**
 * Logging adapter - delivers events to the application log.
 * Useful for development and debugging.
 */
class LoggingAdapter implements DeliveryAdapter {
  name = 'logging';

  canHandle(eventType: string): boolean {
    return true; // Handles all events
  }

  async deliver(event: {
    id: string;
    eventType: string;
    payload: unknown;
    entityId: string;
    entityType: string;
  }): Promise<void> {
    // Idempotent: logging is naturally idempotent
    console.log(`[Outbox] ${event.eventType} for ${event.entityType}:${event.entityId}`, {
      eventId: event.id,
      payload: event.payload,
    });
  }
}

/**
 * Analytics adapter - delivers events to analytics systems.
 * This is a placeholder for future integration with tools like Mixpanel, Amplitude, etc.
 */
class AnalyticsAdapter implements DeliveryAdapter {
  name = 'analytics';

  canHandle(eventType: string): boolean {
    // Only track specific events that are useful for analytics
    return eventType.startsWith('application.') || eventType.startsWith('lead.');
  }

  async deliver(event: {
    id: string;
    eventType: string;
    payload: unknown;
    entityId: string;
    entityType: string;
  }): Promise<void> {
    // TODO: Integrate with actual analytics system
    // For now, just log that we would track this
    console.log(`[Analytics] Would track event: ${event.eventType}`, {
      eventId: event.id,
      entityType: event.entityType,
      entityId: event.entityId,
    });
  }
}

/**
 * Webhook adapter - delivers events to configured webhooks.
 * This is a placeholder for future webhook integration.
 */
class WebhookAdapter implements DeliveryAdapter {
  name = 'webhook';

  canHandle(eventType: string): boolean {
    // Configuration would determine which events get webhooks
    // For now, disable until configured
    return false;
  }

  async deliver(event: {
    id: string;
    eventType: string;
    payload: unknown;
    entityId: string;
    entityType: string;
  }): Promise<void> {
    // TODO: Implement webhook delivery with retry logic
    // - Fetch configured webhooks for this event type
    // - Send event payload to each webhook
    // - Handle idempotency via event ID in headers
    console.log(`[Webhook] Would deliver to webhooks: ${event.eventType}`, {
      eventId: event.id,
    });
  }
}

/**
 * Delivery adapter registry.
 */
const adapters: DeliveryAdapter[] = [
  new LoggingAdapter(),
  new AnalyticsAdapter(),
  new WebhookAdapter(),
];

/**
 * Deliver a single outbox event through all applicable adapters.
 *
 * Each adapter that can handle the event type will attempt delivery.
 * If any adapter fails, the entire delivery is considered failed and will be retried.
 * This ensures at-least-once delivery semantics.
 *
 * Idempotency: The event ID is used to track processing and prevent duplicate
 * side effects when the same event is delivered multiple times.
 */
async function deliverEvent(event: {
  id: string;
  eventType: string;
  payload: unknown;
  entityId: string;
  entityType: string;
}): Promise<void> {
  // Check if this event has already been processed (idempotency)
  if (isEventProcessed(event.id)) {
    console.log(`[Outbox] Event ${event.id} already processed, skipping`);
    return;
  }

  const applicableAdapters = adapters.filter((a) => a.canHandle(event.eventType));

  if (applicableAdapters.length === 0) {
    console.log(`[Outbox] No adapters for event type: ${event.eventType}`);
    return;
  }

  // Deliver through all applicable adapters
  for (const adapter of applicableAdapters) {
    try {
      await adapter.deliver(event);
    } catch (err) {
      console.error(`[Outbox] Adapter ${adapter.name} failed for event ${event.id}:`, err);
      throw err; // Re-throw to trigger retry
    }
  }

  // Mark as processed only after all adapters succeed
  markEventProcessed(event.id);
}

/**
 * Clean up old delivered events.
 *
 * Removes events that were delivered more than the specified days ago to
 * prevent the outbox table from growing indefinitely.
 */
export async function cleanupOldOutboxEvents(daysToKeep: number = 7): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  const result = await prisma.outboxEvent.deleteMany({
    where: {
      deliveredAt: { not: null, lte: cutoffDate },
    },
  });

  return result.count;
}

/**
 * Get statistics about the outbox.
 */
export async function getOutboxStats(): Promise<{
  pending: number;
  delivered: number;
  failed: number;
  deadLettered: number;
  oldestPending: Date | null;
}> {
  const [pending, delivered, failed, deadLettered, oldest] = await Promise.all([
    prisma.outboxEvent.count({ where: { deliveredAt: null, deadLettered: false } }),
    prisma.outboxEvent.count({ where: { deliveredAt: { not: null } } }),
    prisma.outboxEvent.count({ where: { deliveredAt: null, attempts: { gt: 0 }, deadLettered: false } }),
    prisma.outboxEvent.count({ where: { deadLettered: true } }),
    prisma.outboxEvent
      .findFirst({
        where: { deliveredAt: null, deadLettered: false },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      })
      .then((r) => r?.createdAt ?? null),
  ]);

  return { pending, delivered, failed, deadLettered, oldestPending: oldest };
}

/**
 * Replay dead-lettered events.
 *
 * Resets the retry state for dead-lettered events so they can be retried.
 * Useful for fixing issues that caused events to fail permanently.
 */
export async function replayDeadLetteredEvents(eventIds?: string[]): Promise<number> {
  const where = eventIds
    ? { id: { in: eventIds }, deadLettered: true }
    : { deadLettered: true };

  const result = await prisma.outboxEvent.updateMany({
    where,
    data: {
      deadLettered: false,
      deadLetterReason: null,
      attempts: 0,
      lastError: null,
      nextRetryAt: new Date(), // Retry immediately
    },
  });

  return result.count;
}

/**
 * Get dead-lettered events for inspection.
 */
export async function getDeadLetteredEvents(limit: number = 50) {
  return prisma.outboxEvent.findMany({
    where: { deadLettered: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
