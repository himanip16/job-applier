import { countryByCode, type Country } from '@ja/shared';
import { newPage } from '../browser/session.js';
import { type Page } from 'playwright';
import { crawlCareersPage, sourceById, type DiscoveredJob, type FetchHints } from './sources/index.js';
import { admit, emptyTally, openIntake } from './leadIntake.js';
import { screen } from './screening.js';
import { buildSearchPlan, jobMatchesPlan, type SearchPlan } from './searchQueries.js';
import { rescoreLexically } from './rescoreLeads.js';
import { loadScoringContext } from './scoring.js';
import { DEFAULT_DEEP_SCORE_TOP, deepScoreLeads } from './deepScore.js';
import { registerCompany } from './companyRegistration.js';
import { topCompanies, type TargetCompany } from './topCompanies.js';
import { isFirecrawlConfigured } from './firecrawl.js';
import { canonicalUrl } from './jobSearchUtils.js';
import { MAX_POSTING_AGE_DAYS } from './jobFilters.js';
import { ago, crawlKey, markCrawled, recentCrawls, RECRAWL_AFTER_MS } from './crawlTracker.js';

/**
 * Finding openings at the companies worth working for.
 *
 * Search used to be an open web search over every ATS board, which surfaced
 * whoever ranked for the query - mostly small startups. Now it reads the
 * best-paying companies directly (topCompanies.ts), each through the crawler
 * that fits its careers site: a board API for Greenhouse/Lever/Ashby, a
 * careers-site API for Workday, Eightfold, Google, Apple and the rest, and a
 * headless-browser crawl for the few with nothing better.
 *
 * The shape is plan -> read -> filter:
 *
 *  1. Turn the profile into role titles (the same plan as before).
 *  2. Read every target company, passing those titles and the country so the
 *     big sites search server-side instead of handing back thousands of roles.
 *  3. Keep what matches the plan, in the chosen country, not too senior.
 *
 * No search credits are spent: every one of these endpoints is free to read.
 * Everything then joins the existing pipeline - same scoring, same triage,
 * same learning.
 */

export interface BoardOutcome {
  ats: string;
  slug: string;
  company: string;
  /** Openings the site reported for this search, or 0 if we could not reach it. */
  openings: number;
  /** How many became leads. */
  kept: number;
  error?: string;
  warnings?: string[];
}

export interface JobSearchReport {
  planSource: SearchPlan['source'];
  roleTitles: string[];
  /** One entry per role title searched for, with how many relevant postings matched it. */
  queries: { query: string; hits: number }[];
  /** Always 0 now; kept so older clients still render. */
  creditsUsed: number;
  boards: BoardOutcome[];
  jobsSeen: number;
  /** All postings returned by sources, before intake filters. */
  jobsFetched: number;
  newLeads: number;
  skippedAlreadySeen: number;
  skippedTooSenior: number;
  skippedTooJunior: number;
  /** Posted more than MAX_POSTING_AGE_DAYS ago. */
  skippedTooOld: number;
  /** Outside the country you chose to search in, and not remote. */
  skippedOtherCountry: number;
  /** Titles that matched none of the planned roles. */
  skippedOffPlan: number;
  /** Sales, recruiting, legal and the like - not engineering, whatever the keywords. */
  skippedWrongDomain: number;
  /** A few titles behind each of those two counts, so a filter that is too strict is visible. */
  droppedExamples: { offPlan: string[]; wrongDomain: string[]; tooOld: string[]; tooSenior: string[]; tooJunior: string[]; otherCountry: string[] };
  /** Kept postings that did not say where they are: in the queue as "Location unknown". */
  keptUnknownLocation: number;
  /**
   * Listed companies with nothing to read: a bare domain instead of a careers
   * API or page. Not an error - nobody has set their source up yet.
   */
  noSource: string[];
  /** Read successfully within the last few hours, so not read again (crawlTracker.ts). */
  recentlyCrawled: { company: string; crawledAt: string }[];
  deepScored: number;
  companiesRegistered: number;
  /** Leads already in the queue whose cheap score was recomputed afterwards. */
  rerankedExisting: number;
  notes: string[];
  errors: { where: string; error: string }[];
}

/** Seams, so the whole flow is testable without a network. */
export interface FindJobsDeps {
  plan: (profileId: string, opts: { maxQueries: number; country?: Country; openToIndia?: boolean }) => Promise<SearchPlan>;
  companies: (limit: number) => TargetCompany[];
  fetchCompany: (company: TargetCompany, hints: FetchHints) => Promise<DiscoveredJob[]>;
  /** Sites read within RECRAWL_AFTER_MS, keyed by crawlKey(source, handle). */
  recentCrawls: (refs: { source: string; handle: string }[]) => Promise<Map<string, Date>>;
}



const defaultDeps: FindJobsDeps = {
  plan: (profileId, opts) => buildSearchPlan(profileId, opts),
  companies: (limit) => topCompanies(limit),
  fetchCompany: async (company, hints) => {
    const source = sourceById(company.source);
    if (!source) throw new Error(`No crawler registered for "${company.source}"`);
    return source.fetchJobs(company.handle, hints);
  },
  recentCrawls,
};

export interface FindJobsOptions {
  /** Work out what it would search for and stop, without reading any site. */
  dryRun?: boolean;
  maxQueries?: number;
  /** Maximum number of top-ranked companies to consider. Defaults to all. */
  maxBoards?: number;
  deepScoreTop?: number;
  /** Where to look, as an ISO code. Asked for before every search. */
  country?: string;
  /** With no country: keep only jobs someone in India could take. */
  openToIndia?: boolean;
  /**
   * Discovery mode: 'incremental' (default) or 'full'.
   * - incremental: Only crawl companies whose cooldown has expired.
   * - full: Recheck all companies, ignoring the cooldown, with reduced concurrency.
   */
  mode?: 'incremental' | 'full';
  /** @deprecated Use mode: 'full' instead. Read every site, even ones read within the last RECRAWL_AFTER_MS. */
  force?: boolean;
  deps?: Partial<FindJobsDeps>;
}

/**
 * Whether a listed company has anything to read. A careers-page entry needs a
 * real URL; a bare domain like "amazon.com" is a placeholder, and crawling it
 * only fails.
 */
const hasSource = (c: TargetCompany): boolean => c.source !== 'careers-page' || /^https?:\/\//i.test(c.handle);

/** Companies read at once. Each site is still read politely, one request at a time. */
const CONCURRENCY = 6;

/** Reduced concurrency for full refresh to implement rate limiting. */
const FULL_REFRESH_CONCURRENCY = 3;
/** Minimum gap between starting company reads during a full refresh. */
const FULL_REFRESH_START_INTERVAL_MS = 500;

/**
 * How far a running search has got, so the page can show jobs as they are
 * saved instead of a spinner for the whole run.
 */
export interface SearchProgress {
  phase: 'reading' | 'scoring' | 'done';
  startedAt: string;
  finishedAt?: string;
  companiesTotal: number;
  companiesDone: number;
  /** Companies being read right now. */
  reading: string[];
  newLeads: number;
}

const progressByProfile = new Map<string, SearchProgress>();

/** The latest search for this profile: running, or the last one finished. */
export const searchProgress = (profileId: string): SearchProgress | null => progressByProfile.get(profileId) ?? null;

export async function findJobs(profileId: string, opts: FindJobsOptions = {}): Promise<JobSearchReport> {
  try {
    return await runSearch(profileId, opts);
  } finally {
    const progress = progressByProfile.get(profileId);
    if (progress && progress.phase !== 'done') {
      progress.phase = 'done';
      progress.reading = [];
      progress.finishedAt = new Date().toISOString();
    }
  }
}

async function runSearch(
  profileId: string,
  opts: FindJobsOptions,
): Promise<JobSearchReport> {
  const deps: FindJobsDeps = { ...defaultDeps, ...opts.deps };
  const maxQueries = opts.maxQueries ?? 6;
  // The whole list: the API sources answer in a second or two each.
  const maxCompanies = opts.maxBoards ?? Number.POSITIVE_INFINITY;
  const deepScoreTop = opts.deepScoreTop ?? DEFAULT_DEEP_SCORE_TOP;
  const mode = opts.mode ?? 'incremental';
  const forceFullRefresh = opts.force || mode === 'full';

  const report: JobSearchReport = {
    planSource: 'profile',
    roleTitles: [],
    queries: [],
    creditsUsed: 0,
    rerankedExisting: 0,
    boards: [],
    jobsSeen: 0,
    jobsFetched: 0,
    newLeads: 0,
    skippedAlreadySeen: 0,
    skippedTooSenior: 0,
    skippedTooJunior: 0,
    skippedTooOld: 0,
    skippedOtherCountry: 0,
    skippedOffPlan: 0,
    skippedWrongDomain: 0,
    droppedExamples: { offPlan: [], wrongDomain: [], tooOld: [], tooSenior: [], tooJunior: [], otherCountry: [] },
    keptUnknownLocation: 0,
    noSource: [],
    recentlyCrawled: [],
    deepScored: 0,
    companiesRegistered: 0,
    notes: [],
    errors: [],
  };

  const target = countryByCode(opts.country);
  const plan = await deps.plan(profileId, { maxQueries, country: target, openToIndia: !target && opts.openToIndia });
  report.planSource = plan.source;
  report.roleTitles = plan.roleTitles;
  report.notes.push(...plan.notes);
  report.queries = plan.roleTitles.map((query) => ({ query, hits: 0 }));

  const listed = deps.companies(maxCompanies);
  const withSource = listed.filter(hasSource);
  report.noSource = listed.filter((c) => !hasSource(c)).map((c) => c.company);

  // Sites read in the last few hours have nothing new to say; their postings
  // are already in the queue from that read.
  const recent = forceFullRefresh
    ? new Map<string, Date>()
    : await deps.recentCrawls(withSource.map((c) => ({ source: c.source, handle: c.handle })));
  const companies = withSource.filter((c) => !recent.has(crawlKey(c.source, c.handle)));
  report.recentlyCrawled = withSource
    .filter((c) => recent.has(crawlKey(c.source, c.handle)))
    .map((c) => ({ company: c.company, crawledAt: recent.get(crawlKey(c.source, c.handle))!.toISOString() }));
  if (report.recentlyCrawled.length) {
    const hours = RECRAWL_AFTER_MS / 3_600_000;
    const n = report.recentlyCrawled.length;
    const sample = report.recentlyCrawled.slice(0, 5).map((r) => `${r.company}, ${ago(new Date(r.crawledAt))}`);
    report.notes.push(
      `Skipped ${n} compan${n === 1 ? 'y' : 'ies'} already read in the last ${hours} hours (${sample.join('; ')}${n > 5 ? '; ...' : ''}).`,
    );
    log(`skipping ${n} compan(ies) read in the last ${hours}h`);
  }

  // Log the discovery mode
  const concurrency = forceFullRefresh ? FULL_REFRESH_CONCURRENCY : CONCURRENCY;
  if (forceFullRefresh) {
    report.notes.push(`Full refresh: rechecking all ${companies.length} companies with reduced concurrency (${concurrency}).`);
    log(`full refresh mode: reading ${companies.length} companies with concurrency ${concurrency}`);
  } else {
    log(`incremental mode: reading ${companies.length} companies whose cooldown has expired`);
  }

  if (opts.dryRun) {
    report.boards = companies.map((c) => ({ ats: c.source, slug: c.handle, company: c.company, openings: 0, kept: 0 }));
    report.notes.push(
      `Dry run: this would read the ${companies.length} best-paying companies (${companies
        .slice(0, 5)
        .map((c) => c.company)
        .join(', ')}, ...) for these roles. Nothing was read.`,
    );
    return report;
  }

  if (!plan.roleTitles.length) {
    report.notes.push('The plan came back with no role titles, so there was nothing to match postings against.');
    return report;
  }

  // Opened before reading, so each company's jobs are saved the moment it
  // answers and show up in the queue while the rest are still being read.
  const intake = await openIntake(
    profileId,
    { country: target, openToIndia: !target && opts.openToIndia, roleTitles: plan.roleTitles },
    await loadScoringContext(profileId),
  );
  const tally = emptyTally();
  const progress: SearchProgress = {
    phase: 'reading',
    startedAt: new Date().toISOString(),
    companiesTotal: companies.length,
    companiesDone: 0,
    reading: [],
    newLeads: 0,
  };
  progressByProfile.set(profileId, progress);

  log(`reading ${companies.length} companies for ${plan.roleTitles.map((t) => `"${t}"`).join(', ')}`);

  // ---- 1. read every company ------------------------------------------------
  const fetched: { company: TargetCompany; outcome: BoardOutcome; jobs: DiscoveredJob[] }[] = [];

  /**
   * Browser lifecycle for this search. Scoped to this search so concurrent
   * searches don't interfere with each other's browser pages.
   */
  let searchPage: Page | null = null;
  let pageQueue: Promise<unknown> = Promise.resolve();

  const crawlWithBrowser = async (url: string): Promise<DiscoveredJob[]> => {
    const run = pageQueue.then(async () => {
      searchPage ??= await newPage();
      return crawlCareersPage(searchPage, url, { maxPages: 25 });
    });
    pageQueue = run.catch(() => {});
    return run;
  };

  // Patch the fetchCompany dep to use the search-scoped browser
  const fetchCompany = async (company: TargetCompany, hints: FetchHints): Promise<DiscoveredJob[]> => {
    if (company.source === 'careers-page') return crawlWithBrowser(company.handle);
    const source = sourceById(company.source);
    if (!source) throw new Error(`No crawler registered for "${company.source}"`);
    return source.fetchJobs(company.handle, hints);
  };

  const searchDeps: FindJobsDeps = { ...deps, fetchCompany };

  let next = 0;
  let nextFullRefreshStart = 0;
  let fullRefreshStartQueue: Promise<void> = Promise.resolve();
  const paceFullRefresh = async () => {
    const scheduled = fullRefreshStartQueue.then(async () => {
      const now = Date.now();
      const delay = Math.max(0, nextFullRefreshStart - now);
      nextFullRefreshStart = Math.max(now, nextFullRefreshStart) + FULL_REFRESH_START_INTERVAL_MS;
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    });
    fullRefreshStartQueue = scheduled.catch(() => {});
    await scheduled;
  };

  const worker = async () => {
    while (next < companies.length) {
      const company = companies[next++]!;
      const outcome: BoardOutcome = { ats: company.source, slug: company.handle, company: company.company, openings: 0, kept: 0 };
      report.boards.push(outcome);
      progress.reading.push(company.company);
      try {
        const hints: FetchHints = {
          queries: plan.roleTitles,
          country: target,
          onWarning: (message) => {
            outcome.warnings ??= [];
            if (!outcome.warnings.includes(message)) outcome.warnings.push(message);
          },
        };
        if (forceFullRefresh) await paceFullRefresh();
        const jobs = await searchDeps.fetchCompany(company, hints);
        outcome.openings = jobs.length;
        const missingDescriptions = jobs.filter((j) => !j.descriptionText.trim()).length;
        if (missingDescriptions) hints.onWarning?.(`${missingDescriptions} posting(s) have no description; matching and scoring have less evidence.`);
        fetched.push({ company, outcome, jobs });
        const registered = await registerCompany({ ats: company.source, slug: company.handle }, company.company);
        if (registered.created) report.companiesRegistered++;
        await markCrawled(registered.id, `${jobs.length} postings`);
        outcome.kept = await admit(intake, { id: registered.id, name: company.company }, jobs, tally);
        log(`  ${company.company} (${company.source}): ${jobs.length} opening(s), ${outcome.kept} new`);
      } catch (err) {
        outcome.error = (err as Error).message;
        report.errors.push({ where: company.company, error: outcome.error });
        log(`  ${company.company} (${company.source}): FAILED - ${outcome.error}`);
      } finally {
        progress.reading = progress.reading.filter((name) => name !== company.company);
        progress.companiesDone++;
        progress.newLeads = tally.saved;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, worker));
  } finally {
    if (searchPage) {
      await (searchPage as Page).close().catch(() => {});
      searchPage = null;
    }
  }
  // Report in pay order, not in whichever order the sites happened to answer.
  const rank = new Map(companies.map((c, i) => [c.company, i]));
  report.boards.sort((a, b) => rank.get(a.company)! - rank.get(b.company)!);
  fetched.sort((a, b) => rank.get(a.company.company)! - rank.get(b.company.company)!);

  // ---- 2. what matched -------------------------------------------------------
  //
  // Each company's jobs were screened and saved as it answered. The big sites'
  // own search is loose - Apple answers "Software Engineer" with retail
  // specialists - so the plan's titles were the real gate; count what each
  // title caught.
  for (const { jobs } of fetched) {
    for (const job of jobs) {
      if (screen(job, intake.rules)) continue;
      for (const q of report.queries) if (jobMatchesPlan(job, [q.query])) q.hits++;
    }
  }
  report.jobsSeen = tally.relevant;
  report.jobsFetched = report.boards.reduce((sum, b) => sum + b.openings, 0);
  report.newLeads = tally.saved;
  report.keptUnknownLocation = tally.unknownLocation;
  report.skippedAlreadySeen = tally.rejected.alreadySeen;
  report.skippedTooSenior = tally.rejected.tooSenior;
  report.skippedTooJunior = tally.rejected.tooJunior;
  report.skippedTooOld = tally.rejected.tooOld;
  report.skippedOtherCountry = tally.rejected.otherCountry;
  report.skippedOffPlan = tally.rejected.offPlan;
  report.skippedWrongDomain = tally.rejected.wrongDomain;
  report.droppedExamples = {
    offPlan: tally.examples.offPlan, wrongDomain: tally.examples.wrongDomain,
    tooOld: tally.examples.tooOld, tooSenior: tally.examples.tooSenior, tooJunior: tally.examples.tooJunior, otherCountry: tally.examples.otherCountry,
  };
  report.errors.push(...tally.errors);
  const fresh = tally.fresh;

  log(`${report.newLeads} new lead(s) from ${report.jobsSeen} relevant posting(s)`);
  log(`dropped ${report.skippedOffPlan} not in plan, ${report.skippedWrongDomain} not engineering`);
  if (report.skippedTooOld) {
    report.notes.push(`Skipped ${report.skippedTooOld} posting(s) older than ${MAX_POSTING_AGE_DAYS} days.`);
  }

  if (!report.jobsSeen && !report.errors.length && companies.length) {
    report.notes.push(
      `No matching openings were returned by the ${companies.length} companies for these roles${
        target ? ` in ${target.name}` : ''
      }. Check source coverage and filter exclusions below before broadening the roles on your profile.`,
    );
  }

  // ---- 4. read the most promising in full ----------------------------------
  progress.phase = 'scoring';
  if (deepScoreTop > 0) {
    // A search of one company reads that company's new jobs; a full search
    // reads the best of everything still waiting, old leads included.
    // Use companies.length (actual companies read) not listed.length (intended)
    // so a single-company search that was skipped due to recent crawl doesn't
    // incorrectly trigger single-company deep-scoring.
    const deepScoreResult = await deepScoreLeads(
      profileId,
      deepScoreTop,
      companies.length === 1 ? { only: fresh.map((f) => f.id) } : {},
    );
    report.deepScored = deepScoreResult.deepScored;
    report.errors.push(...deepScoreResult.errors.map(e => ({ where: `scoring ${e.company}`, error: e.error })));
  }

  // Re-rank what was already in the queue too. Leads stored before the resume
  // was uploaded - or before the scorer learned to use it - keep the score
  // they were created with unless something goes back for them.
  report.rerankedExisting = await rescoreLexically(profileId);

  return report;
}

/**
 * Progress on stdout.
 *
 * A search run takes tens of seconds and, until it finishes, the UI can only
 * say "Searching...". Without this the honest report from a user is "it is not
 * doing anything", and there is nowhere to look to find out otherwise.
 */
const log = (message: string) => process.stdout.write(`[find] ${message}\n`);

export { isFirecrawlConfigured, canonicalUrl };
