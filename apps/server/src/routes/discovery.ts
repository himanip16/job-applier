import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { crawlAll, rescore } from '../discovery/crawler.js';
import { findJobs } from '../discovery/findJobs.js';
import { isFirecrawlConfigured } from '../discovery/firecrawl.js';
import type { RequireProfile } from './types.js';

export function registerDiscoveryRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.post('/api/discovery/crawl', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { deepScoreTop, companyId } = z
      .object({ deepScoreTop: z.number().min(0).max(60).default(15), companyId: z.string().optional() })
      .parse(req.body ?? {});
    const report = await crawlAll(profile.id, { deepScoreTop, onlyCompanyId: companyId });
    return { report };
  });

  /**
   * Find openings without being told where to look.
   *
   * The primary way in. `/crawl` re-reads boards you already know about;
   * this one goes and finds them, so the first run needs nothing but a
   * resume.
   */
  app.post('/api/discovery/find', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const body = z
      .object({
        dryRun: z.boolean().default(false),
        maxQueries: z.number().min(1).max(12).optional(),
        resultsPerQuery: z.number().min(1).max(30).optional(),
        maxBoards: z.number().min(1).max(60).optional(),
        deepScoreTop: z.number().min(0).max(60).default(15),
      })
      .parse(req.body ?? {});

    // A dry run never touches Firecrawl, so it works without a key - which is
    // exactly when you most want to see what the app thinks it would do.
    if (!body.dryRun && !isFirecrawlConfigured()) {
      return reply.code(400).send({
        error:
          'Job search needs a Firecrawl key. Get one free at firecrawl.dev and add it on the ' +
          'Settings page. Everything else works without it.',
      });
    }

    try {
      return { report: await findJobs(profile.id, body) };
    } catch (err) {
      // Everything reachable from here is a message written for a person -
      // an empty profile, a rejected key, an exhausted balance.
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/discovery/rescore', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { limit } = z.object({ limit: z.number().min(1).max(60).default(20) }).parse(req.body ?? {});
    return { rescored: await rescore(profile.id, limit) };
  });
}
