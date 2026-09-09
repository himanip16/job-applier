import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import type { RequireProfile } from './types.js';
import { composeConnectionMessages } from '../outreach/connectionMessages.js';
import { readConnectionPage, statusTotals } from '../outreach/connectionStatus.js';

/**
 * How the list is cut into sections.
 *
 * The default is conversation status rather than name, because the list exists
 * to answer "who is waiting on me" - see ../outreach/connectionStatus.ts,
 * which computes it. The other three are there for finding one specific
 * person, which is a different job.
 */
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['status', 'name', 'role', 'company']).default('status'),
});

/**
 * Drafting from the connections list.
 *
 * `contactIds` is capped because every AI-mode id is one model call made
 * serially, and a request that selects nine hundred people would sit on the
 * connection until something upstream times out. The cap is a number a person
 * can actually review afterwards, not a safety limit.
 */
const composeSchema = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(50),
  mode: z.enum(['AI', 'TEMPLATE']),
  body: z.string().max(8000).optional(),
  emphasis: z.string().max(500).optional(),
}).refine((value) => value.mode !== 'TEMPLATE' || Boolean(value.body?.trim()), {
  message: 'Write the message you want to send before creating drafts.',
  path: ['body'],
});

export function registerConnectionRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get('/api/linkedin/connections', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Choose a valid page, a page size from 1 to 100, and sort by status, name, role or company.',
      });
    }

    const { pageSize, sort } = parsed.data;
    const where = { profileId: profile.id, isConnection: true };
    const total = await prisma.contact.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(parsed.data.page, totalPages);

    const [connections, statuses, roleGroups] = await Promise.all([
      readConnectionPage({ profileId: profile.id, sort, skip: (page - 1) * pageSize, take: pageSize }),
      statusTotals(profile.id),
      prisma.contact.groupBy({ by: ['role'], where, _count: { _all: true } }),
    ]);

    /**
     * Section totals span the whole list, not this page. A heading reading
     * "Waiting on them (3)" when there are ninety of them, because three
     * landed on this page, is worse than no count at all.
     */
    const roleTotals = Object.fromEntries(
      roleGroups.map((group) => [group.role, group._count._all]),
    ) as Record<string, number>;

    return { connections, total, page, pageSize, totalPages, sort, statusTotals: statuses, roleTotals };
  });

  /**
   * Mark a conversation finished, or reopen it.
   *
   * Explicit because nothing else can know. A thread that has gone quiet reads
   * exactly like one that ended well, and guessing would file people you still
   * mean to chase under "done".
   */
  app.post('/api/linkedin/connections/:id/close', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { id } = req.params as { id: string };
    const closed = z.object({ closed: z.boolean() }).safeParse(req.body);
    if (!closed.success) return reply.code(400).send({ error: 'Say whether the conversation is closed.' });

    const updated = await prisma.contact.updateMany({
      where: { id, profileId: profile.id },
      data: { conversationClosedAt: closed.data.closed ? new Date() : null },
    });
    if (updated.count !== 1) return reply.code(404).send({ error: 'That connection is not on your profile.' });
    return { id, closed: closed.data.closed };
  });

  /**
   * Turn a selection into drafts. Never into sent messages: these come back as
   * DRAFT, and the queue's approve step is still the only door to the sender.
   */
  app.post('/api/linkedin/connections/messages', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const parsed = composeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Select up to 50 connections and choose how to write the message.',
      });
    }

    const result = await composeConnectionMessages({ profileId: profile.id, ...parsed.data });
    return reply.send(result);
  });
}
