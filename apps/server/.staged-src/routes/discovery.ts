import { countryByCode } from '@ja/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { crawlAll, rescore } from '../discovery/crawler.js';
import { findJobs } from '../discovery/findJobs.js';
import { recheckLeads } from '../discovery/recheckLeads.js';
import type { RequireProfile } from './types.js';

export function registerDiscoveryRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.post('/api/discovery/crawl', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { deepScoreTop, companyId, country } = z
      .object({
        deepScoreTop: z.number().min(0).max(60).default(15),
        companyId: z.string().optional(),
        country: z.string().length(2).optional(),
      })
      .parse(req.body ?? {});
    const target = countryByCode(country);
    if (country && !target) return reply.code(400).send({ error: `Searching in "${country}" is not supported yet.` });
    const report = await crawlAll(profile.id, { deepScoreTop, onlyCompanyId: companyId, country: target });
    return { report };
  });

  /**
   * Find openings at the best-paying companies.
   *
   * The primary way in. `/crawl` re-reads boards you already know about;
   * this one reads the top-paying companies in companies_50lpa.json for the
   * roles your profile points at, so the first run needs nothing but a resume.
   */
  app.post('/api/discovery/find', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const body = z
      .object({
        dryRun: z.boolean().default(false),
        maxQueries: z.number().min(1).max(12).optional(),
        maxBoards: z.number().min(1).max(100).optional(),
        deepScoreTop: z.number().min(0).max(60).default(15),
        country: z.string().length(2).optional(),
      })
      .parse(req.body ?? {});

    if (body.country && !countryByCode(body.country)) {
      return reply.code(400).send({ error: `Searching in "${body.country}" is not supported yet.` });
    }

    try {
      return { report: await findJobs(profile.id, body) };
    } catch (err) {
      // Everything reachable from here is a message written for a person -
      // an empty profile, a rejected key, an exhausted balance.
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Re-check the jobs already in the queue: drop the ones now too old, too
   * senior, outside the chosen country, or closed on their board.
   */
  app.post('/api/discovery/recheck-leads', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { country } = z.object({ country: z.string().length(2).optional() }).parse(req.body ?? {});
    const target = countryByCode(country);
    if (country && !target) return reply.code(400).send({ error: `Searching in "${country}" is not supported yet.` });
    return { report: await recheckLeads(profile.id, { country: target }) };
  });

  app.post('/api/discovery/rescore', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { limit } = z.object({ limit: z.number().min(1).max(60).default(20) }).parse(req.body ?? {});
    return { rescored: await rescore(profile.id, limit) };
  });
}
