import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { API_SOURCES } from '../discovery/sources.js';
import { eightfoldSource, smartRecruitersSource, workdaySource } from '../discovery/careerSites.js';
import { isFirecrawlConfigured } from '../discovery/firecrawl.js';
import type { RequireProfile } from './types.js';

/**
 * Coarse buckets for a rejection.
 *
 * Offered as one-tap chips alongside the free-text box, because a category is
 * cheap to give and a sentence is not — and something is far better than the
 * nothing you get when the only option is a blank textarea.
 */
export const REJECT_CATEGORIES = [
  'Too junior',
  'Too senior',
  'Wrong tech stack',
  'Wrong domain',
  'Location or commute',
  'No visa sponsorship',
  'Compensation',
  'Company or culture',
  'Already applied elsewhere',
  'Not looking for this type of role',
] as const;

export function registerCompanyRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get('/api/sources', async () => ({
    // The careers-site platforms many companies share can be added by hand too;
    // the one-company crawlers (Google, Apple, ...) are only reached via search.
    sources: [...API_SOURCES, workdaySource, smartRecruitersSource, eightfoldSource].map((s) => ({ id: s.id, handleHint: s.handleHint })).concat([
      { id: 'careers-page', handleHint: 'full URL of the careers page to crawl' },
    ]),
    rejectCategories: REJECT_CATEGORIES,
    searchConfigured: isFirecrawlConfigured(),
  }));

  app.get('/api/companies', async () => ({
    companies: await prisma.company.findMany({ orderBy: { name: 'asc' } }),
  }));

  app.post('/api/companies', async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        source: z.enum(['greenhouse', 'lever', 'ashby', 'workable', 'workday', 'smartrecruiters', 'eightfold', 'careers-page']),
        handle: z.string().min(1),
      })
      .parse(req.body);
    const company = await prisma.company.upsert({
      where: { source_handle: { source: body.source, handle: body.handle } },
      create: body,
      update: { name: body.name, enabled: true },
    });
    return { company };
  });

  app.delete<{ Params: { id: string } }>('/api/companies/:id', async (req) => {
    await prisma.company.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
}
