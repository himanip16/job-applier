import type { FastifyInstance } from 'fastify';
import { runScheduledJobDiscovery, isSchedulerRunning } from '../lib/scheduler.js';
import { currentUser } from '../auth/sessions.js';

/**
 * Admin routes for managing the job discovery scheduler.
 *
 * These endpoints allow manual triggering of scheduled jobs and checking scheduler status.
 * All admin routes require authentication.
 */
export function registerAdminRoutes(app: FastifyInstance) {
  /**
   * Manually trigger the scheduled job discovery for all profiles.
   *
   * This endpoint runs the same logic as the cron job, but on-demand.
   * Useful for testing or forcing an immediate refresh.
   */
  app.post('/api/admin/run-job-discovery', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Authentication required' });

    try {
      // Run the job discovery asynchronously
      void runScheduledJobDiscovery();
      return { ok: true, message: 'Job discovery started' };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Check if the scheduler is currently running.
   */
  app.get('/api/admin/scheduler-status', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Authentication required' });

    return { running: isSchedulerRunning() };
  });
}
