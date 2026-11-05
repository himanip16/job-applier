import { countryByCode } from '@ja/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveCompany } from '../discovery/companySearch.js';
import { isFirecrawlConfigured } from '../discovery/firecrawl.js';
import { DEFAULT_DEEP_SCORE_TOP } from '../discovery/deepScore.js';
import { findJobs } from '../discovery/findJobs.js';
import type { RequireProfile } from './types.js';

export function registerCompanySearchRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  /**
   * One company's relevant openings, from just its name.
   *
   * Works out where the company posts its jobs (discovery/companySearch.ts),
   * then reads that one company through the same pipeline as /find: matched
   * against the roles on your profile, filtered to the country, scored, and
   * saved to the queue. Always reads it fresh - you asked for this company now.
   */
  app.post('/api/discovery/company', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const body = z
      .object({
        company: z.string().trim().min(1).max(300),
        deepScoreTop: z.number().min(0).max(60).default(DEFAULT_DEEP_SCORE_TOP),
        country: z.string().length(2).optional(),
      })
      .parse(req.body ?? {});

    if (body.country && !countryByCode(body.country)) {
      return reply.code(400).send({ error: `Searching in "${body.country}" is not supported yet.` });
    }

    const { company, notes } = await resolveCompany(body.company);
    if (!company) {
      return reply.code(404).send({
        error:
          `Could not find where ${body.company} posts its jobs: no Greenhouse, Lever, Ashby or Workable board by that name, ` +
          `${isFirecrawlConfigured() ? 'nothing in a web search of those sites, ' : ''}and no LinkedIn company page that matches. ` +
          'Check the spelling, or paste a link to its careers page instead.',
      });
    }

    try {
      const report = await findJobs(profile.id, {
        country: body.country,
        openToIndia: !body.country,
        deepScoreTop: body.deepScoreTop,
        force: true,
        deps: { companies: () => [company] },
      });
      report.notes.unshift(...notes);
      return {
        report,
        company: { company: company.company, source: company.source, handle: company.handle, via: company.via },
      };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
