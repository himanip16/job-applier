import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Page } from 'playwright';
import { prisma } from '../lib/db.js';
import { syncConnections, getSyncStatus } from '../linkedin/sync.js';
import { findColdOutreachTargets, countColdTargetsByRole } from '../outreach/classify.js';
import { generateColdOutreachBatch } from '../outreach/generate.js';
import { NOT_YOURS } from '../auth/ownership.js';
import { linkedInPage, isLoggedIn, hasLinkedInSession } from '../linkedin/session.js';
import { sendOutreach } from '../linkedin/send.js';
import type { RequireProfile } from './discovery.js';

// Store the active sign-in page for cleanup
let signInPage: Page | null = null;

/**
 * Register outreach and LinkedIn sync routes.
 */
export function registerOutreachRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  // LinkedIn sync routes
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

  // LinkedIn connection flow
  app.post('/api/linkedin/connect', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    
    try {
      // Clean up any existing sign-in page
      if (signInPage && !signInPage.isClosed()) {
        await signInPage.close();
      }
      signInPage = null;

      // Update status to WAITING_FOR_SIGN_IN
      await prisma.profile.update({
        where: { id: profile.id },
        data: { linkedinConnectionStatus: 'WAITING_FOR_SIGN_IN' },
      });

      // Launch browser and navigate to LinkedIn (without session check for manual sign-in)
      const { getContext } = await import('../browser/session.js');
      const ctx = await getContext();
      signInPage = await ctx.newPage();
      await signInPage.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/', { waitUntil: 'domcontentloaded', timeout: 45_000 });

      // Check if already logged in
      const loggedIn = await isLoggedIn(signInPage);
      
      if (loggedIn) {
        await prisma.profile.update({
          where: { id: profile.id },
          data: { linkedinConnectionStatus: 'CONNECTED' },
        });
        await signInPage.close();
        signInPage = null;
        return reply.send({ status: 'CONNECTED', message: 'Already logged in to LinkedIn' });
      }

      // Keep page open for user to sign in - page reference stored in module variable
      return reply.send({ status: 'WAITING_FOR_SIGN_IN', message: 'Browser opened. Please sign in to LinkedIn.' });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error occurred';
      await prisma.profile.update({
        where: { id: profile.id },
        data: { linkedinConnectionStatus: 'NOT_CONNECTED' },
      });
      // Clean up page on error
      if (signInPage && !signInPage.isClosed()) {
        await signInPage.close();
      }
      signInPage = null;
      return reply.code(500).send({ error: 'Failed to open LinkedIn', details: error });
    }
  });

  app.get('/api/linkedin/connection-status', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const profileData = await prisma.profile.findUnique({
      where: { id: profile.id },
      select: { linkedinConnectionStatus: true },
    });

    if (!profileData) {
      return reply.code(404).send({ error: 'Profile not found' });
    }

    // If status is WAITING_FOR_SIGN_IN, check if user has completed sign-in
    if (profileData.linkedinConnectionStatus === 'WAITING_FOR_SIGN_IN') {
      try {
        // Only check if we have an active sign-in page - prevents creating new pages during polling
        if (signInPage && !signInPage.isClosed()) {
          const loggedIn = await isLoggedIn(signInPage);
          
          if (loggedIn) {
            await prisma.profile.update({
              where: { id: profile.id },
              data: { linkedinConnectionStatus: 'CONNECTED' },
            });
            await signInPage.close();
            signInPage = null;
            return reply.send({ status: 'CONNECTED' });
          }
        } else {
          // Sign-in page is closed - user either finished or abandoned
          // Fall back to cookie check to determine final status
          const hasSession = await hasLinkedInSession();
          if (hasSession) {
            await prisma.profile.update({
              where: { id: profile.id },
              data: { linkedinConnectionStatus: 'CONNECTED' },
            });
            return reply.send({ status: 'CONNECTED' });
          } else {
            // No session and no page - user abandoned sign-in
            await prisma.profile.update({
              where: { id: profile.id },
              data: { linkedinConnectionStatus: 'NOT_CONNECTED' },
            });
            return reply.send({ status: 'NOT_CONNECTED' });
          }
        }
      } catch (err) {
        // If we can't check, return current status
      }
    }

    return reply.send({ status: profileData.linkedinConnectionStatus });
  });

  // Cold outreach target routes
  app.get('/api/outreach/cold/targets', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const targets = await findColdOutreachTargets(profile.id);
    return reply.send(targets);
  });

  app.get('/api/outreach/cold/count', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const counts = await countColdTargetsByRole(profile.id);
    return reply.send(counts);
  });

  // Generate cold outreach
  app.post('/api/outreach/cold/generate', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
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
        profileId: profile.id,
      },
    });

    if (validContactsCount !== uniqueContactIds.length) {
      return reply.code(403).send({ error: NOT_YOURS });
    }

    // Verify jobLeadId belongs to this profile if provided
    if (body.jobLeadId) {
      const jobLead = await prisma.jobLead.findFirst({
        where: {
          id: body.jobLeadId,
          profileId: profile.id,
        },
      });

      if (!jobLead) {
        return reply.code(403).send({ error: NOT_YOURS });
      }
    }

    const result = await generateColdOutreachBatch({
      profileId: profile.id,
      contactIds: uniqueContactIds,
      jobLeadId: body.jobLeadId,
    });

    return reply.send(result);
  });

  // Outreach item counts
  app.get('/api/outreach/items/counts', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const [cold, replyItems, followUp] = await Promise.all([
      prisma.outreachItem.count({
        where: { profileId: profile.id, type: 'COLD', status: { in: ['DRAFT', 'APPROVED'] } },
      }),
      prisma.outreachItem.count({
        where: { profileId: profile.id, type: 'REPLY', status: { in: ['DRAFT', 'APPROVED'] } },
      }),
      prisma.outreachItem.count({
        where: { profileId: profile.id, type: 'FOLLOW_UP', status: { in: ['DRAFT', 'APPROVED'] } },
      }),
    ]);

    return reply.send({ COLD: cold, REPLY: replyItems, FOLLOW_UP: followUp });
  });

  // Outreach item CRUD
  app.get('/api/outreach/items', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
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
    const profile = await requireProfile(req, reply);
    if (!profile) return;
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
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    return reply.send(item);
  });

  app.put('/api/outreach/items/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { id } = req.params as { id: string };

    const schema = z.object({
      finalBody: z.string().trim().min(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Body text is required' });
    }

    // First get the item to check current status
    const item = await prisma.outreachItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    // Only allow editing DRAFT and APPROVED items - prevent modifying historical records
    if (item.status === 'SENT' || item.status === 'SKIPPED') {
      return reply.code(400).send({ error: 'Cannot edit items that have been sent or skipped' });
    }

    const result = await prisma.outreachItem.updateMany({
      where: {
        id,
        profileId: profile.id,
        status: { in: ['DRAFT', 'APPROVED'] }, // Ensure status hasn't changed
      },
      data: {
        finalBody: parsed.data.finalBody,
        editedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const updated = await prisma.outreachItem.findUnique({
      where: { id },
    });

    return reply.send(updated);
  });

  app.post('/api/outreach/items/:id/approve', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { id } = req.params as { id: string };

    // First get the item to check if it exists and get the draft body
    const item = await prisma.outreachItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    // Only allow approving DRAFT items - prevent corrupting sent/skipped history
    if (item.status !== 'DRAFT') {
      return reply.code(400).send({ error: 'Can only approve items in DRAFT status' });
    }

    const result = await prisma.outreachItem.updateMany({
      where: {
        id,
        profileId: profile.id,
        status: 'DRAFT', // Ensure status hasn't changed
      },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        finalBody: item.finalBody || item.draftBody,
      },
    });

    if (result.count === 0) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const updated = await prisma.outreachItem.findUnique({
      where: { id },
    });

    return reply.send(updated);
  });

  app.post('/api/outreach/items/:id/skip', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { id } = req.params as { id: string };

    const schema = z.object({
      reason: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid payload' });
    }

    // First get the item to check current status
    const item = await prisma.outreachItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    // Only allow skipping DRAFT items - prevent corrupting sent/approved history
    if (item.status !== 'DRAFT') {
      return reply.code(400).send({ error: 'Can only skip items in DRAFT status' });
    }

    const result = await prisma.outreachItem.updateMany({
      where: {
        id,
        profileId: profile.id,
        status: 'DRAFT', // Ensure status hasn't changed
      },
      data: {
        status: 'SKIPPED',
        statusReason: parsed.data.reason,
      },
    });

    if (result.count === 0) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const updated = await prisma.outreachItem.findUnique({
      where: { id },
    });

    return reply.send(updated);
  });

  app.post('/api/outreach/items/:id/mark-sent', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { id } = req.params as { id: string };

    // First get the item to check current status
    const item = await prisma.outreachItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

    // Only allow marking APPROVED items as SENT - prevent bypassing review
    if (item.status !== 'APPROVED') {
      return reply.code(400).send({ error: 'Can only mark APPROVED items as SENT' });
    }

    const body = (item.finalBody || item.draftBody).trim();
    const contact = await prisma.contact.findFirst({
      where: { id: item.contactId, profileId: profile.id },
    });
    if (!contact) return reply.code(404).send({ error: 'Contact not found' });

    let page: Page | null = null;
    try {
      page = await linkedInPage();
      await sendOutreach(page, {
        profileUrl: contact.profileUrl,
        channel: item.channel,
        body,
      });
    } catch (err) {
      return reply.code(502).send({
        error: 'LinkedIn did not confirm that the message was sent',
        details: err instanceof Error ? err.message : 'Unknown LinkedIn error',
      });
    } finally {
      await page?.close().catch(() => {});
    }

    const result = await prisma.outreachItem.updateMany({
      where: {
        id,
        profileId: profile.id,
        status: 'APPROVED', // Ensure status hasn't changed
      },
      data: {
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    if (result.count === 0) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const updated = await prisma.outreachItem.findUnique({
      where: { id },
    });

    return reply.send(updated);
  });
}
