import { prisma, type Prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { newPage } from '../browser/session.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import {
  API_SOURCES,
  crawlCareersPage,
  sourceById,
  type DiscoveredJob,
} from './sources.js';
import {
  assessFit,
  blendScores,
  buildPreferences,
  buildRejectionHistory,
  loadScoringContext,
  scoreLexically,
  serialiseReasons,
} from './scoring.js';
import { applyHardRules, candidateConstraints } from './hardRules.js';
import { rescoreLeads, rescoreLexically } from './rescoreLeads.js';

export interface CrawlReport {
  companiesCrawled: number;
  jobsSeen: number;
  newLeads: number;
  skippedAlreadyDecided: number;
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
      let jobs: DiscoveredJob[] = [];
      try {
        if (company.source === 'careers-page') {
          page ??= await newPage();
          jobs = await crawlCareersPage(page, company.handle);
        } else {
          const source = sourceById(company.source);
          if (!source) throw new Error(`Unknown source "${company.source}"`);
          jobs = await source.fetchJobs(company.handle);
        }
        // The board APIs return the slug, not the display name.
        jobs = jobs.map((j) => ({ ...j, companyName: company.name || j.companyName }));

        await prisma.company.update({
          where: { id: company.id },
          data: { lastCrawledAt: new Date(), lastCrawlNote: `${jobs.length} postings` },
        });
      } catch (err) {
        const message = (err as Error).message;
        report.errors.push({ company: company.name, error: message });
        await prisma.company.update({
          where: { id: company.id },
          data: { lastCrawledAt: new Date(), lastCrawlNote: `failed: ${message}` },
        });
        continue;
      }

      report.companiesCrawled++;
      report.jobsSeen += jobs.length;

      for (const job of jobs) {
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
  if (fresh.length && deepScoreTop > 0) {
    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      include: { facts: true },
    });
    if (profile) {
      const candidateContext = renderCandidateContext(profile, profile.resumeText);
      const constraints = candidateConstraints(profile);
      const preferences = await buildPreferences(profileId);
      const rejectionHistory = await buildRejectionHistory(profileId);

      const shortlist = fresh.sort((a, b) => b.lexScore - a.lexScore).slice(0, deepScoreTop);
      for (const entry of shortlist) {
        try {
          const raw = await assessFit({
            candidateContext,
            preferences,
            rejectionHistory,
            job: entry.job,
          });
          if (!raw) continue;
          const fit = applyHardRules(raw, { ...constraints, job: entry.job });
          const lex = scoreLexically(entry.job, scoring);
          // Blend, weighted toward the model - it read the description, the
          // lexical prior only saw word counts. A hard blocker overrides both.
          const blended = blendScores(fit, lex);
          await prisma.jobLead.update({
            where: { id: entry.id },
            data: {
              score: blended,
              scoreReasons: serialiseReasons(lex, fit) as Prisma.InputJsonValue,
              deepScored: true,
              scoredAt: new Date(),
            },
          });
          report.deepScored++;
        } catch (err) {
          // A scoring failure must not lose the lead; it keeps its lexical
          // score and can be re-scored later.
          report.errors.push({ company: entry.job.companyName, error: (err as Error).message });
        }
      }
    }
  }

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
