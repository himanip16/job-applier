import { countryByCode, type Country } from '@ja/shared';
import { newPage } from '../browser/session.js';
import { crawlCareersPage, sourceById, type DiscoveredJob, type FetchHints } from './sources/index.js';
import { admit, emptyTally, openIntake, screen } from './leadIntake.js';
import { buildSearchPlan, jobMatchesPlan, type SearchPlan } from './searchQueries.js';
import { rescoreLexically } from './rescoreLeads.js';
import { loadScoringContext } from './scoring.js';
import { deepScoreLeads } from './deepScore.js';
import { registerCompany } from './companyRegistration.js';
import { topCompanies, type TargetCompany } from './topCompanies.js';
import { isFirecrawlConfigured } from './firecrawl.js';
import { canonicalUrl } from './jobSearchUtils.js';
import { MAX_POSTING_AGE_DAYS } from './jobFilters.js';

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
  /** Posted more than MAX_POSTING_AGE_DAYS ago. */
  skippedTooOld: number;
  /** Outside the country you chose to search in, and not remote. */
  skippedOtherCountry: number;
  /** Titles that matched none of the planned roles. */
  skippedOffPlan: number;
  /** Sales, recruiting, legal and the like - not engineering, whatever the keywords. */
  skippedWrongDomain: number;
  /** A few titles behind each of those two counts, so a filter that is too strict is visible. */
  droppedExamples: { offPlan: string[]; wrongDomain: string[]; tooOld: string[]; tooSenior: string[]; otherCountry: string[] };
  /** Kept postings that did not say where they are: in the queue as "Location unknown". */
  keptUnknownLocation: number;
  /**
   * Listed companies with nothing to read: a bare domain instead of a careers
   * API or page. Not an error - nobody has set their source up yet.
   */
  noSource: string[];
  deepScored: number;
  companiesRegistered: number;
  /** Leads already in the queue whose cheap score was recomputed afterwards. */
  rerankedExisting: number;
  notes: string[];
  errors: { where: string; error: string }[];
}

/** Seams, so the whole flow is testable without a network. */
export interface FindJobsDeps {
  plan: (profileId: string, opts: { maxQueries: number; country?: Country }) => Promise<SearchPlan>;
  companies: (limit: number) => TargetCompany[];
  fetchCompany: (company: TargetCompany, hints: FetchHints) => Promise<DiscoveredJob[]>;
}

/**
 * The careers-page crawls share one browser page and run one at a time; the
 * API sources are plain HTTP and need none.
 */
let sharedPage: Awaited<ReturnType<typeof newPage>> | null = null;
let pageQueue: Promise<unknown> = Promise.resolve();

async function crawlWithBrowser(url: string): Promise<DiscoveredJob[]> {
  const run = pageQueue.then(async () => {
    sharedPage ??= await newPage();
    return crawlCareersPage(sharedPage, url, { maxPages: 25 });
  });
  pageQueue = run.catch(() => {});
  return run;
}

const defaultDeps: FindJobsDeps = {
  plan: (profileId, opts) => buildSearchPlan(profileId, opts),
  companies: (limit) => topCompanies(limit),
  fetchCompany: async (company, hints) => {
    if (company.source === 'careers-page') return crawlWithBrowser(company.handle);
    const source = sourceById(company.source);
    if (!source) throw new Error(`No crawler registered for "${company.source}"`);
    return source.fetchJobs(company.handle, hints);
  },
};

export interface FindJobsOptions {
  /** Work out what it would search for and stop, without reading any site. */
  dryRun?: boolean;
  maxQueries?: number;
  /** How many of the best-paying companies to read. */
  maxBoards?: number;
  deepScoreTop?: number;
  /** Where to look, as an ISO code. Asked for before every search. */
  country?: string;
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

export async function findJobs(
  profileId: string,
  opts: FindJobsOptions = {},
): Promise<JobSearchReport> {
  const deps: FindJobsDeps = { ...defaultDeps, ...opts.deps };
  const maxQueries = opts.maxQueries ?? 6;
  // The whole list: the API sources answer in a second or two each.
  const maxCompanies = opts.maxBoards ?? 100;
  const deepScoreTop = opts.deepScoreTop ?? 15;

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
    skippedTooOld: 0,
    skippedOtherCountry: 0,
    skippedOffPlan: 0,
    skippedWrongDomain: 0,
    droppedExamples: { offPlan: [], wrongDomain: [], tooOld: [], tooSenior: [], otherCountry: [] },
    keptUnknownLocation: 0,
    noSource: [],
    deepScored: 0,
    companiesRegistered: 0,
    notes: [],
    errors: [],
  };

  const target = countryByCode(opts.country);
  const plan = await deps.plan(profileId, { maxQueries, country: target });
  report.planSource = plan.source;
  report.roleTitles = plan.roleTitles;
  report.notes.push(...plan.notes);
  report.queries = plan.roleTitles.map((query) => ({ query, hits: 0 }));

  const listed = deps.companies(maxCompanies);
  const companies = listed.filter(hasSource);
  report.noSource = listed.filter((c) => !hasSource(c)).map((c) => c.company);

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

  log(`reading ${companies.length} companies for ${plan.roleTitles.map((t) => `"${t}"`).join(', ')}`);

  // ---- 1. read every company ------------------------------------------------
  const fetched: { company: TargetCompany; outcome: BoardOutcome; jobs: DiscoveredJob[] }[] = [];

  let next = 0;
  const worker = async () => {
    while (next < companies.length) {
      const company = companies[next++]!;
      const outcome: BoardOutcome = { ats: company.source, slug: company.handle, company: company.company, openings: 0, kept: 0 };
      report.boards.push(outcome);
      try {
        const hints: FetchHints = {
          queries: plan.roleTitles,
          country: target,
          onWarning: (message) => {
            outcome.warnings ??= [];
            if (!outcome.warnings.includes(message)) outcome.warnings.push(message);
          },
        };
        const jobs = await deps.fetchCompany(company, hints);
        outcome.openings = jobs.length;
        const missingDescriptions = jobs.filter((j) => !j.descriptionText.trim()).length;
        if (missingDescriptions) hints.onWarning?.(`${missingDescriptions} posting(s) have no description; matching and scoring have less evidence.`);
        fetched.push({ company, outcome, jobs });
        log(`  ${company.company} (${company.source}): ${jobs.length} opening(s)`);
      } catch (err) {
        outcome.error = (err as Error).message;
        report.errors.push({ where: company.company, error: outcome.error });
        log(`  ${company.company} (${company.source}): FAILED - ${outcome.error}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, companies.length) }, worker));
  } finally {
    await sharedPage?.close().catch(() => {});
    sharedPage = null;
  }
  // Report in pay order, not in whichever order the sites happened to answer.
  const rank = new Map(companies.map((c, i) => [c.company, i]));
  report.boards.sort((a, b) => rank.get(a.company)! - rank.get(b.company)!);
  fetched.sort((a, b) => rank.get(a.company.company)! - rank.get(b.company.company)!);

  // ---- 2. keep what matches -------------------------------------------------
  //
  // The big sites' own search is loose - Apple answers "Software Engineer"
  // with retail specialists - so the plan's titles are the real gate.
  const intake = await openIntake(
    profileId,
    { country: target, roleTitles: plan.roleTitles },
    await loadScoringContext(profileId),
  );
  const tally = emptyTally();
  for (const { company, outcome, jobs } of fetched) {
    const registered = await registerCompany({ ats: company.source, slug: company.handle }, company.company);
    if (registered.created) report.companiesRegistered++;
    outcome.kept = await admit(intake, { id: registered.id, name: company.company }, jobs, tally);
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
  report.skippedTooOld = tally.rejected.tooOld;
  report.skippedOtherCountry = tally.rejected.otherCountry;
  report.skippedOffPlan = tally.rejected.offPlan;
  report.skippedWrongDomain = tally.rejected.wrongDomain;
  report.droppedExamples = {
    offPlan: tally.examples.offPlan, wrongDomain: tally.examples.wrongDomain,
    tooOld: tally.examples.tooOld, tooSenior: tally.examples.tooSenior, otherCountry: tally.examples.otherCountry,
  };
  report.errors.push(...tally.errors);
  const fresh = tally.fresh;

  log(`${report.newLeads} new lead(s) from ${report.jobsSeen} relevant posting(s)`);
  log(`dropped ${report.skippedOffPlan} not in plan, ${report.skippedWrongDomain} not engineering`);
  if (report.skippedTooOld) {
    report.notes.push(`Skipped ${report.skippedTooOld} posting(s) older than ${MAX_POSTING_AGE_DAYS} days.`);
  }

  if (!report.jobsSeen && !report.errors.length) {
    report.notes.push(
      `No matching openings were returned by the ${companies.length} companies for these roles${
        target ? ` in ${target.name}` : ''
      }. Check source coverage and filter exclusions below before broadening the roles on your profile.`,
    );
  }

  // ---- 4. read the most promising in full ----------------------------------
  if (fresh.length && deepScoreTop > 0) {
    const deepScoreResult = await deepScoreLeads(profileId, fresh, deepScoreTop);
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
