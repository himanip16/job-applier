import { prisma, type Prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { newPage } from '../browser/session.js';
import { type DiscoveredJob } from './sources.js';
import {
  loadScoringContext,
  scoreLexically,
  serialiseReasons,
} from './scoring.js';
import { rescoreLeads, rescoreLexically } from './rescoreLeads.js';
import { isSeniorLevel, requiresMoreThan5YearsExperience } from './jobFilters.js';
import { crawlCompany } from './crawlCompany.js';
import { deepScoreLeads } from './deepScore.js';

export interface CrawlReport {
  companiesCrawled: number;
  jobsSeen: number;
  newLeads: number;
  skippedAlreadyDecided: number;
  skippedTooSenior: number;
  deepScored: number;
  /** Leads already in the queue whose cheap score was recomputed afterwards. */
  rerankedExisting: number;
  errors: { company: string; error: string }[];
}

/**
 * Crawl every enabled company, score what comes back, and store the leads.
 *
 * Scoring is two-pass and the split matters for cost: every job gets the free
 * lexical score, and only the top slice gets a model read. A 400-job crawl
 * therefore costs a handful of model calls rather than 400.
 */
export async function crawlAll(
  profileId: string,
  opts: { deepScoreTop?: number; onlyCompanyId?: string } = {},
): Promise<CrawlReport> {
  const deepScoreTop = opts.deepScoreTop ?? 15;

  const companies = await prisma.company.findMany({
    where: { enabled: true, ...(opts.onlyCompanyId ? { id: opts.onlyCompanyId } : {}) },
  });

  const report: CrawlReport = {
    companiesCrawled: 0,
    jobsSeen: 0,
    newLeads: 0,
    skippedAlreadyDecided: 0,
    skippedTooSenior: 0,
    deepScored: 0,
    rerankedExisting: 0,
    errors: [],
  };

  const scoring = await loadScoringContext(profileId);
  const fresh: { id: string; job: DiscoveredJob; lexScore: number }[] = [];

  // A page is only created if a careers-page crawl actually needs one; the API
  // sources are plain HTTP.
  let page: Awaited<ReturnType<typeof newPage>> | null = null;

  try {
    for (const company of companies) {
      const { jobs, page: updatedPage, error } = await crawlCompany(company, page);
      page = updatedPage;

      if (error) {
        report.errors.push({ company: company.name, error });
        await prisma.company.update({
          where: { id: company.id },
          data: { lastCrawledAt: new Date(), lastCrawlNote: `failed: ${error}` },
        });
        continue;
      }

      report.companiesCrawled++;
      report.jobsSeen += jobs.length;

      await prisma.company.update({
        where: { id: company.id },
        data: { lastCrawledAt: new Date(), lastCrawlNote: `${jobs.length} postings` },
      });

      for (const job of jobs) {
        // Filter out senior-level positions
        if (isSeniorLevel(job.title)) {
          report.skippedTooSenior++;
          continue;
        }

        // Filter out jobs requiring more than 5 years of experience
        if (requiresMoreThan5YearsExperience(job.descriptionText)) {
          report.skippedTooSenior++;
          continue;
        }

        const existing = await prisma.jobLead.findUnique({
          where: { profileId_url: { profileId, url: job.url } },
        });
        // Never resurrect something already decided. Re-showing a job the
        // candidate rejected last week is the fastest way to make a triage
        // queue unusable.
        if (existing) {
          report.skippedAlreadyDecided++;
          continue;
        }

        const lex = scoreLexically(job, scoring);
        const lead = await prisma.jobLead.create({
          data: {
            profileId,
            companyId: company.id,
            url: job.url,
            ats: job.ats,
            title: job.title,
            companyName: job.companyName,
            location: job.location ?? null,
            remote: job.remote,
            descriptionText: job.descriptionText,
            postedAt: job.postedAt ?? null,
            score: lex.score,
            scoreReasons: serialiseReasons(lex, null),
            scoredAt: new Date(),
            deepScored: false,
          },
        });
        report.newLeads++;
        fresh.push({ id: lead.id, job, lexScore: lex.score });
      }
    }
  } finally {
    await page?.close().catch(() => {});
  }

  // ---- model pass over the most promising ---------------------------------
  const deepScoreResult = await deepScoreLeads(profileId, fresh, deepScoreTop);
  report.deepScored = deepScoreResult.deepScored;
  report.errors.push(...deepScoreResult.errors);

  // Leave the whole queue correctly ranked, not just the rows this crawl
  // added. Leads stored before the resume was uploaded - or before the scorer
  // learned to use it - are still carrying the score they were created with,
  // and nothing else would ever revisit them.
  report.rerankedExisting = await rescoreLexically(profileId);

  bus.emit('crawl', report);
  return report;
}

/** Re-run the model pass over leads that never got one, or that are stale. */
export async function rescore(profileId: string, limit = 20): Promise<number> {
  const leads = await prisma.jobLead.findMany({
    where: { profileId, status: 'NEW' },
    orderBy: [{ deepScored: 'asc' }, { score: 'desc' }],
    take: limit,
  });
  const outcomes = await rescoreLeads(profileId, leads);
  return outcomes.filter((o) => o.ok).length;
}
