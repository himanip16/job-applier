import { countryByCode, locatedIn, type Country } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { newPage } from '../browser/session.js';
import { crawlCareersPage, sourceById, type DiscoveredJob, type FetchHints } from './sources/index.js';
import { buildSearchPlan, titleMatchesPlan, type SearchPlan } from './searchQueries.js';
import { rescoreLexically } from './rescoreLeads.js';
import { loadScoringContext, scoreLexically, serialiseReasons } from './scoring.js';
import { deepScoreLeads, type DeepScoreEntry } from './deepScore.js';
import { registerCompany } from './companyRegistration.js';
import { topCompanies, type TargetCompany } from './topCompanies.js';
import { isFirecrawlConfigured } from './firecrawl.js';
import { canonicalUrl, isSeniorLevel, requiresMoreThan5YearsExperience } from './jobSearchUtils.js';

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
  newLeads: number;
  skippedAlreadySeen: number;
  skippedTooSenior: number;
  /** Outside the country you chose to search in, and not remote. */
  skippedOtherCountry: number;
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

/** Companies read at once. Each site is still read politely, one request at a time. */
const CONCURRENCY = 6;

export async function findJobs(
  profileId: string,
  opts: FindJobsOptions = {},
): Promise<JobSearchReport> {
  const deps: FindJobsDeps = { ...defaultDeps, ...opts.deps };
  const maxQueries = opts.maxQueries ?? 6;
  const maxCompanies = opts.maxBoards ?? 50;
  const deepScoreTop = opts.deepScoreTop ?? 15;

  const report: JobSearchReport = {
    planSource: 'profile',
    roleTitles: [],
    queries: [],
    creditsUsed: 0,
    rerankedExisting: 0,
    boards: [],
    jobsSeen: 0,
    newLeads: 0,
    skippedAlreadySeen: 0,
    skippedTooSenior: 0,
    skippedOtherCountry: 0,
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

  const companies = deps.companies(maxCompanies);

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
  const hints: FetchHints = { queries: plan.roleTitles, country: target };
  const fetched: { company: TargetCompany; outcome: BoardOutcome; jobs: DiscoveredJob[] }[] = [];

  let next = 0;
  const worker = async () => {
    while (next < companies.length) {
      const company = companies[next++]!;
      const outcome: BoardOutcome = { ats: company.source, slug: company.handle, company: company.company, openings: 0, kept: 0 };
      report.boards.push(outcome);
      try {
        const jobs = await deps.fetchCompany(company, hints);
        outcome.openings = jobs.length;
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

  // ---- 2. what do we already have? -----------------------------------------
  //
  // One query rather than one per posting. A decided lead must never come
  // back: re-offering a job someone rejected last week is how a triage queue
  // stops being used.
  const existing = new Set(
    (await prisma.jobLead.findMany({ where: { profileId }, select: { url: true } })).map((l) =>
      canonicalUrl(l.url),
    ),
  );

  const scoring = await loadScoringContext(profileId);
  const fresh: DeepScoreEntry[] = [];

  // ---- 3. keep what matches -------------------------------------------------
  for (const { company, outcome, jobs } of fetched) {
    const registered = await registerCompany({ ats: company.source, slug: company.handle }, company.company);
    if (registered.created) report.companiesRegistered++;

    for (const job of jobs) {
      if (isSeniorLevel(job.title) || requiresMoreThan5YearsExperience(job.descriptionText)) {
        report.skippedTooSenior++;
        continue;
      }

      // The big sites' own search is loose - Apple answers "Software Engineer"
      // with retail specialists - so the plan's titles are the real gate.
      if (!titleMatchesPlan(job.title, plan.roleTitles)) continue;

      // A board lists every office. You asked for one country.
      if (target && !locatedIn(job.location, job.remote, target)) {
        report.skippedOtherCountry++;
        continue;
      }

      report.jobsSeen++;
      for (const q of report.queries) if (titleMatchesPlan(job.title, [q.query])) q.hits++;

      const canonical = canonicalUrl(job.url);
      if (existing.has(canonical)) {
        report.skippedAlreadySeen++;
        continue;
      }
      existing.add(canonical);

      const named: DiscoveredJob = { ...job, companyName: company.company };
      const lex = scoreLexically(named, scoring);
      try {
        const lead = await prisma.jobLead.create({
          data: {
            profileId,
            companyId: registered.id,
            url: job.url,
            ats: job.ats,
            title: job.title,
            companyName: named.companyName,
            location: job.location ?? null,
            remote: job.remote,
            descriptionText: job.descriptionText,
            postedAt: job.postedAt && !Number.isNaN(job.postedAt.getTime()) ? job.postedAt : null,
            score: lex.score,
            scoreReasons: serialiseReasons(lex, null),
            scoredAt: new Date(),
            deepScored: false,
          },
        });
        report.newLeads++;
        outcome.kept++;
        fresh.push({ id: lead.id, job: named, lexScore: lex.score });
      } catch (err) {
        report.errors.push({ where: `saving ${job.url}`, error: (err as Error).message });
      }
    }
  }

  log(`${report.newLeads} new lead(s) from ${report.jobsSeen} relevant posting(s)`);

  if (!report.jobsSeen && !report.errors.length) {
    report.notes.push(
      `None of the ${companies.length} companies has an opening matching these roles${
        target ? ` in ${target.name}` : ''
      } right now. Try again in a few days, or broaden the roles on your profile.`,
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
