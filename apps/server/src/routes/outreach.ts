import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../lib/db.js';
import { syncConnections, getSyncStatus } from '../linkedin/sync.js';
import { findColdOutreachTargets, countColdTargetsByRole } from '../outreach/classify.js';
import { generateColdOutreachBatch } from '../outreach/generate.js';
import { currentUser } from '../auth/sessions.js';
import { NOT_YOURS } from '../auth/ownership.js';
import { linkedInPage, isLoggedIn, hasLinkedInSession } from '../linkedin/session.js';

// Extend FastifyRequest type to include profile
declare module 'fastify' {
  interface FastifyRequest {
    profile?: { id: string };
  }
}

/**
 * Middleware helper to authenticate and load profile
 */
async function requireProfile(req: FastifyRequest, reply: FastifyReply) {
  const user = await currentUser(req);
  if (!user) {
    reply.code(401).send({ error: 'Sign in required' });
    return;
  }

  const profile = await prisma.profile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });

  if (!profile) {
    reply.code(404).send({ error: 'Profile not found' });
    return;
  }

  req.profile = profile;
}

/**
 * Register outreach and LinkedIn sync routes.
 */
export function registerOutreachRoutes(app: FastifyInstance) {
  // Apply profile authentication hook to all routes in this scope
  app.addHook('preHandler', requireProfile);

  // LinkedIn sync routes
  app.post('/api/linkedin/sync/connections', async (req, reply) => {
    const result = await syncConnections(req.profile!.id);
    return reply.send(result);
  });

  app.get('/api/linkedin/sync/status', async (req, reply) => {
    const [connectionsStatus, messagesStatus] = await Promise.all([
      getSyncStatus(req.profile!.id, 'CONNECTIONS'),
      getSyncStatus(req.profile!.id, 'MESSAGES'),
    ]);

    return reply.send({
      connections: connectionsStatus,
      messages: messagesStatus,
    });
  });

  // LinkedIn connection flow
  app.post('/api/linkedin/connect', async (req, reply) => {
    try {
      // Update status to WAITING_FOR_SIGN_IN
      await prisma.profile.update({
        where: { id: req.profile!.id },
        data: { linkedinConnectionStatus: 'WAITING_FOR_SIGN_IN' },
      });

      // Launch browser and navigate to LinkedIn
      const page = await linkedInPage();
      await page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded', timeout: 45_000 });

      // Check if already logged in
      const loggedIn = await isLoggedIn(page);
      
      if (loggedIn) {
        await prisma.profile.update({
          where: { id: req.profile!.id },
          data: { linkedinConnectionStatus: 'CONNECTED' },
        });
        await page.close();
        return reply.send({ status: 'CONNECTED', message: 'Already logged in to LinkedIn' });
      }

      // Keep page open for user to sign in
      return reply.send({ status: 'WAITING_FOR_SIGN_IN', message: 'Browser opened. Please sign in to LinkedIn.' });
    } catch (err) {
      const error = (err as Error).message;
      await prisma.profile.update({
        where: { id: req.profile!.id },
        data: { linkedinConnectionStatus: 'NOT_CONNECTED' },
      });
      return reply.code(500).send({ error: 'Failed to open LinkedIn', details: error });
    }
  });

  app.get('/api/linkedin/connection-status', async (req, reply) => {
    const profile = await prisma.profile.findUnique({
      where: { id: req.profile!.id },
      select: { linkedinConnectionStatus: true },
    });

    if (!profile) {
      return reply.code(404).send({ error: 'Profile not found' });
    }

    // If status is WAITING_FOR_SIGN_IN, check if user has completed sign-in
    if (profile.linkedinConnectionStatus === 'WAITING_FOR_SIGN_IN') {
      try {
        const hasSession = await hasLinkedInSession();
        if (hasSession) {
          // Verify by checking page state
          const page = await linkedInPage();
          const loggedIn = await isLoggedIn(page);
          await page.close();

          if (loggedIn) {
            await prisma.profile.update({
              where: { id: req.profile!.id },
              data: { linkedinConnectionStatus: 'CONNECTED' },
            });
            return reply.send({ status: 'CONNECTED' });
          }
        }
      } catch (err) {
        // If we can't check, return current status
      }
    }

    return reply.send({ status: profile.linkedinConnectionStatus });
  });

  // Cold outreach target routes
  app.get('/api/outreach/cold/targets', async (req, reply) => {
    const targets = await findColdOutreachTargets(req.profile!.id);
    return reply.send(targets);
  });

  app.get('/api/outreach/cold/count', async (req, reply) => {
    const counts = await countColdTargetsByRole(req.profile!.id);
    return reply.send(counts);
  });

  // Generate cold outreach
  app.post('/api/outreach/cold/generate', async (req, reply) => {
    const schema = z.object({
      contactIds: z.array(z.string().min(1)).min(1),
      jobLeadId: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid payload', details: parsed.error.format() });
    }
    const body = parsed.data;

    const uniqueContactIds = Array.from(new Set(body.contactIds));

    // Verify all contacts exist and belong to this profile
    const validContactsCount = await prisma.contact.count({
      where: {
        id: { in: uniqueContactIds },
        profileId: req.profile!.id,
      },
    });

    if (validContactsCount !== uniqueContactIds.length) {
      return reply.code(403).send({ error: NOT_YOURS });
    }

    const result = await generateColdOutreachBatch({
      profileId: req.profile!.id,
      contactIds: uniqueContactIds,
      jobLeadId: body.jobLeadId,
    });

    return reply.send(result);
  });

  // Outreach item CRUD
  app.get('/api/outreach/items', async (req, reply) => {
    const schema = z.object({
      type: z.enum(['COLD', 'REPLY', 'FOLLOW_UP']).optional(),
      status: z.enum(['DRAFT', 'APPROVED', 'SENT', 'SKIPPED']).optional(),
    });

    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters' });
    }
    const query = parsed.data;

    const items = await prisma.outreachItem.findMany({
      where: {
        profileId: req.profile!.id,
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
    const { id } = req.params as { id: string };

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
    if (item.profileId !== req.profile!.id) return reply.code(403).send({ error: NOT_YOURS });

    return reply.send(item);
  });

  app.put('/api/outreach/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const schema = z.object({
      finalBody: z.string().trim().min(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Body text is required' });
    }

    const item = await prisma.outreachItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== req.profile!.id) return reply.code(403).send({ error: NOT_YOURS });

    const updated = await prisma.outreachItem.update({
      where: { id },
      data: {
        finalBody: parsed.data.finalBody,
        editedAt: new Date(),
      },
    });

    return reply.send(updated);
  });

  app.post('/api/outreach/items/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };

    const item = await prisma.outreachItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== req.profile!.id) return reply.code(403).send({ error: NOT_YOURS });

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
    const { id } = req.params as { id: string };

    const schema = z.object({
      reason: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid payload' });
    }

    const item = await prisma.outreachItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== req.profile!.id) return reply.code(403).send({ error: NOT_YOURS });

    const updated = await prisma.outreachItem.update({
      where: { id },
      data: {
        status: 'SKIPPED',
        statusReason: parsed.data.reason,
      },
    });

    return reply.send(updated);
  });

  app.post('/api/outreach/items/:id/mark-sent', async (req, reply) => {
    const { id } = req.params as { id: string };

    const item = await prisma.outreachItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== req.profile!.id) return reply.code(403).send({ error: NOT_YOURS });

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
