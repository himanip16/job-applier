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
  buildPreferences,
  buildRejectionHistory,
  loadSignals,
  scoreLexically,
  serialiseReasons,
} from './scoring.js';

export interface CrawlReport {
  companiesCrawled: number;
  jobsSeen: number;
  newLeads: number;
  skippedAlreadyDecided: number;
  deepScored: number;
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
    errors: [],
  };

  const signals = await loadSignals(profileId);
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

        const lex = scoreLexically(job, signals);
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
      const preferences = await buildPreferences(profileId);
      const rejectionHistory = await buildRejectionHistory(profileId);

      const shortlist = fresh.sort((a, b) => b.lexScore - a.lexScore).slice(0, deepScoreTop);
      for (const entry of shortlist) {
        try {
          const fit = await assessFit({
            candidateContext,
            preferences,
            rejectionHistory,
            job: entry.job,
          });
          if (!fit) continue;
          const lex = scoreLexically(entry.job, signals);
          // Blend, weighted toward the model - it read the description, the
          // lexical prior only saw word counts. A hard blocker overrides both.
          const blended = fit.dealbreaker ? Math.min(fit.score, 15) : 0.7 * fit.score + 0.3 * lex.score;
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

  bus.emit('crawl', report);
  return report;
}

/** Re-run the model pass over leads that never got one, or that are stale. */
export async function rescore(profileId: string, limit = 20): Promise<number> {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    include: { facts: true },
  });
  if (!profile) return 0;

  const leads = await prisma.jobLead.findMany({
    where: { profileId, status: 'NEW' },
    orderBy: [{ deepScored: 'asc' }, { score: 'desc' }],
    take: limit,
  });
  if (!leads.length) return 0;

  const candidateContext = renderCandidateContext(profile, profile.resumeText);
  const preferences = await buildPreferences(profileId);
  const rejectionHistory = await buildRejectionHistory(profileId);
  const signals = await loadSignals(profileId);

  let done = 0;
  for (const lead of leads) {
    const job = {
      title: lead.title,
      companyName: lead.companyName,
      location: lead.location ?? undefined,
      descriptionText: lead.descriptionText ?? '',
      remote: lead.remote,
    };
    try {
      const fit = await assessFit({ candidateContext, preferences, rejectionHistory, job });
      if (!fit) continue;
      const lex = scoreLexically(job, signals);
      const blended = fit.dealbreaker ? Math.min(fit.score, 15) : 0.7 * fit.score + 0.3 * lex.score;
      await prisma.jobLead.update({
        where: { id: lead.id },
        data: {
          score: blended,
          scoreReasons: serialiseReasons(lex, fit) as Prisma.InputJsonValue,
          deepScored: true,
          scoredAt: new Date(),
        },
      });
      done++;
    } catch {
      // Leave it at its lexical score and move on.
    }
  }
  return done;
}

/**
 * Re-apply the lexical score to every undecided lead.
 *
 * Called immediately after each decision, because the whole promise of the
 * triage queue is that rejecting one job re-ranks the ones like it. Without
 * this, the sibling posting two rows down keeps the score it was crawled with
 * and the learning is invisible until the next crawl.
 *
 * Free to run: no network, no model, and a queue is tens of rows.
 *
 * Leads that have had a model read keep it - their score is a blend the model
 * dominates, so re-deriving it from word counts alone would be a downgrade.
 * Their lexical component is refreshed on the next full rescore instead.
 */
export async function rescoreLexically(profileId: string): Promise<number> {
  const signals = await loadSignals(profileId);
  const leads = await prisma.jobLead.findMany({
    where: { profileId, status: 'NEW', deepScored: false },
  });

  let updated = 0;
  for (const lead of leads) {
    const lex = scoreLexically(
      {
        title: lead.title,
        descriptionText: lead.descriptionText ?? '',
        location: lead.location ?? undefined,
      },
      signals,
    );
    // Permanently remove very poor lexical matches so the queue stays useful.
    if (lex.score < 45) {
      try {
        await prisma.jobLead.delete({ where: { id: lead.id } });
      } catch {
        // If deletion fails for some reason, skip and continue.
      }
      continue;
    }

    await prisma.jobLead.update({
      where: { id: lead.id },
      data: {
        score: lex.score,
        scoreReasons: serialiseReasons(lex, null),
        scoredAt: new Date(),
      },
    });
    updated++;
  }
  return updated;
}
