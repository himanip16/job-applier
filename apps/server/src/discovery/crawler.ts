import type { Country } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { newPage } from '../browser/session.js';
import { loadScoringContext } from './scoring.js';
import { rescoreLeads, rescoreLexically } from './rescoreLeads.js';
import { crawlCompany } from './crawlCompany.js';
import { deepScoreLeads } from './deepScore.js';
import { admit, emptyTally, openIntake } from './leadIntake.js';
import { crawledRecently } from './crawlTracker.js';

export interface CrawlReport {
  companiesCrawled: number;
  /** Read successfully within the last few hours, so left alone (crawlTracker.ts). */
  skippedRecentlyCrawled: number;
  jobsSeen: number;
  newLeads: number;
  skippedAlreadyDecided: number;
  skippedTooSenior: number;
  skippedTooJunior: number;
  /** Posted more than MAX_POSTING_AGE_DAYS ago. */
  skippedTooOld: number;
  /** Outside the country you chose, and not remote. */
  skippedOtherCountry: number;
  deepScored: number;
  /** Leads already in the queue whose cheap score was recomputed afterwards. */
  rerankedExisting: number;
  errors: { company: string; error: string }[];
}

/**
 * Crawl every enabled company, score what comes back, and store the leads.
 *
 * Postings go through the same intake as search (leadIntake.ts), so the
 * country you chose is honoured here too.
 *
 * Scoring is two-pass and the split matters for cost: every job gets the free
 * lexical score, and only the top slice gets a model read. A 400-job crawl
 * therefore costs a handful of model calls rather than 400.
 */
export async function crawlAll(
  profileId: string,
  opts: { deepScoreTop?: number; onlyCompanyId?: string; country?: Country; openToIndia?: boolean; force?: boolean } = {},
): Promise<CrawlReport> {
  const deepScoreTop = opts.deepScoreTop ?? 15;

  const enabled = await prisma.company.findMany({
    where: { enabled: true, ...(opts.onlyCompanyId ? { id: opts.onlyCompanyId } : {}) },
  });
  const companies = opts.force ? enabled : enabled.filter((c) => !crawledRecently(c));

  const report: CrawlReport = {
    companiesCrawled: 0,
    skippedRecentlyCrawled: enabled.length - companies.length,
    jobsSeen: 0,
    newLeads: 0,
    skippedAlreadyDecided: 0,
    skippedTooSenior: 0,
    skippedTooJunior: 0,
    skippedTooOld: 0,
    skippedOtherCountry: 0,
    deepScored: 0,
    rerankedExisting: 0,
    errors: [],
  };

  const intake = await openIntake(profileId, { country: opts.country, openToIndia: opts.openToIndia }, await loadScoringContext(profileId));
  const tally = emptyTally();

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
      await prisma.company.update({
        where: { id: company.id },
        data: { lastCrawledAt: new Date(), lastCrawlNote: `${jobs.length} postings` },
      });
      await admit(intake, company, jobs, tally);
    }
  } finally {
    await page?.close().catch(() => {});
  }

  report.jobsSeen = tally.relevant;
  report.newLeads = tally.saved;
  report.skippedAlreadyDecided = tally.rejected.alreadySeen;
  report.skippedTooSenior = tally.rejected.tooSenior;
  report.skippedTooJunior = tally.rejected.tooJunior;
  report.skippedTooOld = tally.rejected.tooOld;
  report.skippedOtherCountry = tally.rejected.otherCountry;
  report.errors.push(...tally.errors.map((e) => ({ company: e.where, error: e.error })));

  // ---- model pass over the most promising ---------------------------------
  const deepScoreResult = await deepScoreLeads(profileId, tally.fresh, deepScoreTop);
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
