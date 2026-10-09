import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/db.js';
import { findColdOutreachTargets, countColdTargetsByRole } from '../../outreach/classify.js';
import { generateColdOutreachBatch } from '../../outreach/generate.js';
import { requireProfile } from '../../auth/requireProfile.js';
import { NOT_YOURS } from '../../auth/ownership.js';

/**
 * Register cold outreach target routes.
 */
export function registerColdOutreachRoutes(app: FastifyInstance) {
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

  app.post('/api/outreach/cold/generate', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const schema = z.object({
      contactIds: z.array(z.string().min(1)).min(1),
      jobLeadId: z.string().optional(),
    });

    const body = schema.parse(req.body);

    // Verify all contacts belong to this profile
    const contactIds = [...new Set(body.contactIds)];
    const contacts = await prisma.contact.findMany({
      where: { id: { in: contactIds }, profileId: profile.id },
    });
    if (contacts.length !== contactIds.length) {
      return reply.code(403).send({ error: NOT_YOURS });
    }

    if (body.jobLeadId) {
      const lead = await prisma.jobLead.findFirst({
        where: { id: body.jobLeadId, profileId: profile.id },
      });
      if (!lead) return reply.code(403).send({ error: NOT_YOURS });
    }

    const result = await generateColdOutreachBatch({
      profileId: profile.id,
      contactIds,
      jobLeadId: body.jobLeadId,
    });

    return reply.send(result);
  });
}
