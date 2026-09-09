import type { FastifyInstance } from 'fastify';
import { registerLinkedInSyncRoutes } from './sync.js';
import { registerColdOutreachRoutes } from './cold.js';
import { registerOutreachItemRoutes } from './items.js';

/**
 * Register all outreach routes.
 */
export function registerOutreachRoutes(app: FastifyInstance) {
  registerLinkedInSyncRoutes(app);
  registerColdOutreachRoutes(app);
  registerOutreachItemRoutes(app);
}
