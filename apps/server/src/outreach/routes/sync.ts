import type { FastifyInstance } from 'fastify';
import { syncConnections, getSyncStatus } from '../../linkedin/sync.js';
import { requireProfile } from '../../auth/requireProfile.js';

/**
 * Register LinkedIn sync routes.
 */
export function registerLinkedInSyncRoutes(app: FastifyInstance) {
  app.post('/api/linkedin/sync/connections', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const result = await syncConnections(profile.id);
    return reply.send(result);
  });

  app.get('/api/linkedin/sync/status', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const [connectionsStatus, messagesStatus] = await Promise.all([
      getSyncStatus(profile.id, 'CONNECTIONS'),
      getSyncStatus(profile.id, 'MESSAGES'),
    ]);

    return reply.send({
      connections: connectionsStatus,
      messages: messagesStatus,
    });
  });
}
