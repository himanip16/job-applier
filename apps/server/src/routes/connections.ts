import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import type { RequireProfile } from './types.js';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function registerConnectionRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get('/api/linkedin/connections', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Choose a valid page and a page size from 1 to 100.' });

    const { pageSize } = parsed.data;
    const where = { profileId: profile.id, isConnection: true };
    const total = await prisma.contact.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(parsed.data.page, totalPages);
    const connections = await prisma.contact.findMany({
      where,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, fullName: true, headline: true, companyName: true,
        profileUrl: true, role: true, location: true,
      },
    });
    return { connections, total, page, pageSize, totalPages };
  });
}
