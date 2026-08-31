import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { syncConnections, getSyncStatus } from '../linkedin/sync.js';
import { findColdOutreachTargets, countColdTargetsByRole } from '../outreach/classify.js';
import { generateColdOutreachBatch } from '../outreach/generate.js';
import { currentUser } from '../auth/sessions.js';
import { NOT_YOURS } from '../auth/ownership.js';

/**
 * Register outreach and LinkedIn sync routes.
 */
export function registerOutreachRoutes(app: FastifyInstance) {
  // LinkedIn sync routes
  app.post('/api/linkedin/sync/connections', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const result = await syncConnections(profile.id);
    return reply.send(result);
  });

  app.get('/api/linkedin/sync/status', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const [connectionsStatus, messagesStatus] = await Promise.all([
      getSyncStatus(profile.id, 'CONNECTIONS'),
      getSyncStatus(profile.id, 'MESSAGES'),
    ]);

    return reply.send({
      connections: connectionsStatus,
      messages: messagesStatus,
    });
  });

  // Cold outreach target routes
  app.get('/api/outreach/cold/targets', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const targets = await findColdOutreachTargets(profile.id);
    return reply.send(targets);
  });

  app.get('/api/outreach/cold/count', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const counts = await countColdTargetsByRole(profile.id);
    return reply.send(counts);
  });

  // Generate cold outreach
  app.post('/api/outreach/cold/generate', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const schema = z.object({
      contactIds: z.array(z.string()),
      jobLeadId: z.string().optional(),
    });

    const body = schema.parse(req.body);

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    // Verify all contacts belong to this profile
    const contacts = await prisma.contact.findMany({
      where: { id: { in: body.contactIds } },
    });

    const invalidContacts = contacts.filter((c) => c.profileId !== profile.id);
    if (invalidContacts.length > 0) {
      return reply.code(403).send({ error: NOT_YOURS });
    }

    const result = await generateColdOutreachBatch({
      profileId: profile.id,
      contactIds: body.contactIds,
      jobLeadId: body.jobLeadId,
    });

    return reply.send(result);
  });

  // Outreach item CRUD
  app.get('/api/outreach/items', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const schema = z.object({
      type: z.enum(['COLD', 'REPLY', 'FOLLOW_UP']).optional(),
      status: z.enum(['DRAFT', 'APPROVED', 'SENT', 'SKIPPED']).optional(),
    });

    const query = schema.parse(req.query);

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const items = await prisma.outreachItem.findMany({
      where: {
        profileId: profile.id,
        ...(query.type && { type: query.type }),
        ...(query.status && { status: query.status }),
      },
      include: {
        contact: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send(items);
  });

  app.get('/api/outreach/items/:id', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const { id } = req.params as { id: string };

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const item = await prisma.outreachItem.findUnique({
      where: { id },
      include: {
        contact: true,
        conversation: {
          include: {
            messages: {
              orderBy: { sentAt: 'desc' },
              take: 20,
            },
          },
        },
      },
    });

    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    return reply.send(item);
  });

  app.put('/api/outreach/items/:id', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const { id } = req.params as { id: string };

    const schema = z.object({
      finalBody: z.string(),
    });

    const body = schema.parse(req.body);

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const item = await prisma.outreachItem.findUnique({
      where: { id },
    });

    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    const updated = await prisma.outreachItem.update({
      where: { id },
      data: {
        finalBody: body.finalBody,
        editedAt: new Date(),
      },
    });

    return reply.send(updated);
  });

  app.post('/api/outreach/items/:id/approve', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const { id } = req.params as { id: string };

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const item = await prisma.outreachItem.findUnique({
      where: { id },
    });

    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    const updated = await prisma.outreachItem.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        finalBody: item.finalBody || item.draftBody,
      },
    });

    return reply.send(updated);
  });

  app.post('/api/outreach/items/:id/skip', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const { id } = req.params as { id: string };

    const schema = z.object({
      reason: z.string().optional(),
    });

    const body = schema.parse(req.body);

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const item = await prisma.outreachItem.findUnique({
      where: { id },
    });

    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    const updated = await prisma.outreachItem.update({
      where: { id },
      data: {
        status: 'SKIPPED',
        statusReason: body.reason,
      },
    });

    return reply.send(updated);
  });

  app.post('/api/outreach/items/:id/mark-sent', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });

    const { id } = req.params as { id: string };

    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });

    const item = await prisma.outreachItem.findUnique({
      where: { id },
    });

    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    const updated = await prisma.outreachItem.update({
      where: { id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    return reply.send(updated);
  });
}
