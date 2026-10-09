import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/db.js';
import { requireProfile } from '../../auth/requireProfile.js';
import { NOT_YOURS } from '../../auth/ownership.js';
import type { Page } from 'playwright';
import { linkedInPage } from '../../linkedin/session.js';
import { sendOutreach } from '../../linkedin/send.js';

/**
 * Register outreach item CRUD routes.
 */
export function registerOutreachItemRoutes(app: FastifyInstance) {
  app.get('/api/outreach/items', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const schema = z.object({
      type: z.enum(['COLD', 'REPLY', 'FOLLOW_UP']).optional(),
      status: z.enum(['DRAFT', 'APPROVED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED']).optional(),
    });

    const query = schema.parse(req.query);

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
      finalBody: z.string(),
    });

    const body = schema.parse(req.body);

    const item = await prisma.outreachItem.findUnique({
      where: { id },
    });

    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });
    
    // Only allow editing DRAFT or APPROVED messages (not SENT, SKIPPED, or FAILED)
    if (!['DRAFT', 'APPROVED'].includes(item.status)) {
      return reply.code(400).send({ 
        error: 'Cannot edit messages that have already been sent, skipped, or failed.',
        currentStatus: item.status,
      });
    }

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
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const { id } = req.params as { id: string };

    const item = await prisma.outreachItem.findUnique({
      where: { id },
    });

    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });
    
    // Only allow DRAFT → APPROVED transition
    if (item.status !== 'DRAFT') {
      return reply.code(400).send({ 
        error: 'Only draft messages can be approved.',
        currentStatus: item.status,
      });
    }

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
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const { id } = req.params as { id: string };

    const schema = z.object({
      reason: z.string().optional(),
    });

    const body = schema.parse(req.body);

    const item = await prisma.outreachItem.findUnique({
      where: { id },
    });

    if (!item) return reply.code(404).send({ error: 'Not found' });
    if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });
    
    // Only allow DRAFT → SKIPPED transition (can't skip already sent messages)
    if (item.status !== 'DRAFT') {
      return reply.code(400).send({ 
        error: 'Only draft messages can be skipped.',
        currentStatus: item.status,
      });
    }

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
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const { id } = req.params as { id: string };

    // Atomically claim the item: APPROVED → SENDING
    const claimed = await prisma.outreachItem.updateMany({
      where: {
        id,
        profileId: profile.id,
        status: 'APPROVED',
      },
      data: {
        status: 'SENDING',
      },
    });

    if (claimed.count !== 1) {
      return reply.code(409).send({
        error: 'Message is already being sent or is no longer approved.',
      });
    }

    const item = await prisma.outreachItem.findUnique({
      where: { id },
      include: { contact: true },
    });

    if (!item) return reply.code(404).send({ error: 'Not found' });

    // Only check for resume if this channel requires it
    if (item.channel === 'DIRECT_MESSAGE') {
      const resume = await prisma.resumeFile.findFirst({
        where: { profileId: profile.id },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
      if (!resume) {
        // Rollback to APPROVED since we can't send
        await prisma.outreachItem.update({
          where: { id },
          data: { status: 'APPROVED' },
        });
        return reply.code(400).send({ error: 'Upload a resume before sending LinkedIn outreach.' });
      }
    }

    let page: Page | null = null;
    try {
      page = await linkedInPage();
      await sendOutreach(page, {
        profileUrl: item.contact.profileUrl,
        channel: item.channel,
        body: item.finalBody || item.draftBody,
        resumePath: item.channel === 'DIRECT_MESSAGE' 
          ? (await prisma.resumeFile.findFirst({
              where: { profileId: profile.id },
              orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
            }))?.path 
          : undefined,
      });
    } catch (err) {
      // Transition to FAILED on LinkedIn error
      await prisma.outreachItem.update({
        where: { id },
        data: {
          status: 'FAILED',
          statusReason: err instanceof Error ? err.message : 'Unknown LinkedIn error',
        },
      });
      return reply.code(502).send({
        error: 'LinkedIn did not confirm the send.',
        details: err instanceof Error ? err.message : 'Unknown LinkedIn error',
      });
    } finally {
      await page?.close().catch(() => {});
    }

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
