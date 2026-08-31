import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { NOT_YOURS, ownedApplication } from '../auth/ownership.js';
import type { RequireProfile } from './discovery.js';
import type { RunEvent } from '@ja/shared';

const allowedOrigins = (process.env.WEB_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export function registerStreamRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get<{ Params: { id: string } }>('/api/applications/:id/stream', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    if (!(await ownedApplication(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);

    const requestOrigin = req.headers.origin as string | undefined;
    const origin = allowedOrigins.length && requestOrigin && allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : (allowedOrigins[0] ?? '*');
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    });

    const send = (evt: RunEvent) => {
      reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
    };

    const channel = `app:${req.params.id}`;
    bus.on(channel, send);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    const history = await prisma.applicationEvent.findMany({
      where: { applicationId: req.params.id },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    for (const e of history) {
      send({
        applicationId: e.applicationId,
        type: e.type,
        message: e.message,
        data: e.data,
        at: e.createdAt.toISOString(),
      });
    }

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      bus.off(channel, send);
    });
  });
}
