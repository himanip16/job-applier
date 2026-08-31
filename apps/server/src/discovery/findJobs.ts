import { prisma, type Prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { sourceById, type DiscoveredJob } from './sources.js';
import {
  ATS_SEARCH_DOMAINS,
  boardKey,
  companyNameFromTitle,
  parseBoardUrl,
  type BoardRef,
} from './boardUrls.js';
import { firecrawlSearch, isFirecrawlConfigured, type SearchHit } from './firecrawl.js';
import { buildSearchPlan, titleMatchesPlan, type SearchPlan } from './searchQueries.js';
import { rescoreLexically } from './rescoreLeads.js';
import { applyHardRules, extractCandidateConstraints } from './hardRules.js';
import {
  assessFit,
  blendScores,
  buildPreferences,
  buildRejectionHistory,
  loadScoringContext,
  type ScoringContext,
  scoreLexically,
  serialiseReasons,
} from './scoring.js';

/**
 * Finding openings without being told where to look.
 *
 * The existing crawler answers "what is open at the companies I listed". This
 * answers "who is hiring someone like me", which is the question you actually
 * have at the start of a job hunt, and it needs a different first move: web
 * search rather than a board API, because a board API needs a slug you do not
 * have yet.
 *
 * The shape is search -> identify -> hydrate:
 *
 *  1. Turn the profile into a handful of queries.
 *  2. Search, restricted to the ATS hosts we can actually apply on. A posting
 *     we cannot submit is not a lead, it is a distraction.
 *  3. Reduce each hit to the board it lives on, then pull that board's own
 *     JSON API for the full, structured posting.
 *
 * Step 3 is the one worth defending. It would be simpler to scrape the pages
 * search returned, and much worse: the board APIs give complete descriptions,
 * real locations and posting dates with no parsing, they cost nothing, and
 * they hand back every *other* opening at that company at the same time. One
 * search hit at a company routinely turns into four leads.
 *
 * Everything then joins the existing pipeline - same scoring, same triage,
 * same learning - so a job found this way is indistinguishable downstream from
 * one found by the crawler.
 */

export interface BoardOutcome {
  ats: string;
  slug: string;
  company: string;
  /** Openings the board reported, or 0 if we could not reach it. */
  openings: number;
  /** How many became leads. */
  kept: number;
  error?: string;
}

export interface JobSearchReport {
  planSource: SearchPlan['source'];
  roleTitles: string[];
  queries: { query: string; hits: number }[];
  creditsUsed: number;
  boards: BoardOutcome[];
  jobsSeen: number;
  newLeads: number;
  skippedAlreadySeen: number;
  deepScored: number;
  companiesRegistered: number;
  /** Leads already in the queue whose cheap score was recomputed afterwards. */
  rerankedExisting: number;
  notes: string[];
  errors: { where: string; error: string }[];
}

/** Seams, so the whole flow is testable without a network or an API key. */
export interface FindJobsDeps {
  search: (query: string, opts: { includeDomains: string[]; limit: number; country?: string }) =>
    Promise<{ hits: SearchHit[]; creditsUsed: number; warning?: string }>;
  fetchBoard: (ref: BoardRef) => Promise<DiscoveredJob[]>;
  plan: (profileId: string, opts: { maxQueries: number }) => Promise<SearchPlan>;
}

const defaultDeps: FindJobsDeps = {
  search: (query, opts) => firecrawlSearch(query, opts),
  fetchBoard: async (ref) => {
    const source = sourceById(ref.ats);
    if (!source) throw new Error(`No source registered for "${ref.ats}"`);
    return source.fetchJobs(ref.slug);
  },
  plan: (profileId, opts) => buildSearchPlan(profileId, opts),
};

export interface FindJobsOptions {
  /**
   * Work out what it would search for and stop, without spending a credit.
   *
   * The answer to "I pressed the button and nothing happened" is almost always
   * visible here, and finding it out should not cost anything.
   */
  dryRun?: boolean;
  maxQueries?: number;
  resultsPerQuery?: number;
  /** Bound the work: a run that hydrates ninety boards takes minutes. */
  maxBoards?: number;
  deepScoreTop?: number;
  deps?: Partial<FindJobsDeps>;
}

export async function findJobs(
  profileId: string,
  opts: FindJobsOptions = {},
): Promise<JobSearchReport> {
  const deps: FindJobsDeps = { ...defaultDeps, ...opts.deps };
  const maxQueries = opts.maxQueries ?? config.jobSearchQueries;
  const resultsPerQuery = opts.resultsPerQuery ?? config.jobSearchResultsPerQuery;
  const maxBoards = opts.maxBoards ?? 25;
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
    deepScored: 0,
    companiesRegistered: 0,
    notes: [],
    errors: [],
  };

  const plan = await deps.plan(profileId, { maxQueries });
  report.planSource = plan.source;
  report.roleTitles = plan.roleTitles;
  report.notes.push(...plan.notes);

  if (opts.dryRun) {
    report.queries = plan.queries.map((query) => ({ query, hits: 0 }));
    report.notes.push(
      'Dry run: this is what it would search for. Nothing was searched and no credits were spent.',
    );
    return report;
  }

  log(`searching ${plan.queries.length} quer${plan.queries.length === 1 ? 'y' : 'ies'} ` +
      `(plan from ${plan.source})`);

  // ---- 1. search -----------------------------------------------------------
  //
  // Boards are keyed so the same company found by three different queries is
  // hydrated once. The matched URLs are tracked separately because those are
  // the postings the candidate was actually looking for, and they are kept
  // regardless of what the title-matching gate makes of their siblings.
  const boards = new Map<string, { ref: BoardRef; name?: string }>();
  const matchedUrls = new Set<string>();
  const hitsByUrl = new Map<string, SearchHit>();

  for (const query of plan.queries) {
    try {
      const { hits, creditsUsed, warning } = await deps.search(query, {
        includeDomains: [...ATS_SEARCH_DOMAINS],
        limit: resultsPerQuery,
        country: plan.country,
      });
      report.creditsUsed += creditsUsed;
      if (warning) report.notes.push(warning);

      let usable = 0;
      for (const hit of hits) {
        const ref = parseBoardUrl(hit.url);
        if (!ref) continue;
        usable++;
        matchedUrls.add(canonicalUrl(hit.url));
        hitsByUrl.set(canonicalUrl(hit.url), hit);
        const key = boardKey(ref);
        if (!boards.has(key)) {
          boards.set(key, { ref, name: companyNameFromTitle(hit.title, ref.slug) });
        }
      }
      report.queries.push({ query, hits: usable });
      log(`  "${query}" -> ${hits.length} result(s), ${usable} on a board we can apply to`);
    } catch (err) {
      report.errors.push({ where: `search "${query}"`, error: (err as Error).message });
      report.queries.push({ query, hits: 0 });
      log(`  "${query}" -> FAILED: ${(err as Error).message}`);
      // A dead key or an exhausted balance fails every remaining query the
      // same way; nine more identical errors help nobody.
      if (!isTransient(err)) break;
    }
  }

  log(`found ${boards.size} board(s) to read`);

  if (!boards.size) {
    if (!report.errors.length) {
      report.notes.push(
        'The searches ran but nothing came back on a job board we can apply to. Try again ' +
          'later, or add a company by hand below.',
      );
    }
    return report;
  }

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
  const fresh: { id: string; job: DiscoveredJob; lexScore: number }[] = [];

  // ---- 3. hydrate ----------------------------------------------------------
  const selected = [...boards.values()].slice(0, maxBoards);
  if (boards.size > selected.length) {
    report.notes.push(
      `Found ${boards.size} companies; hydrated the first ${selected.length}. Run it again to pick up the rest.`,
    );
  }

  for (const [index, entry] of selected.entries()) {
    const outcome: BoardOutcome = {
      ats: entry.ref.ats,
      slug: entry.ref.slug,
      company: entry.name || entry.ref.slug,
      openings: 0,
      kept: 0,
    };
    report.boards.push(outcome);

    // These are public APIs meant to be read, but a burst of requests is still
    // rude. A quarter-second between boards costs nothing here.
    if (index > 0) await sleep(250);

    let jobs: DiscoveredJob[];
    try {
      jobs = await deps.fetchBoard(entry.ref);
      outcome.openings = jobs.length;
      log(`  ${outcome.company} (${entry.ref.ats}/${entry.ref.slug}): ${jobs.length} opening(s)`);
    } catch (err) {
      // The board API refused - a renamed slug, a private board, an outage.
      // The posting search found is still real, so fall back to that rather
      // than dropping the company entirely.
      outcome.error = (err as Error).message;
      log(`  ${outcome.company} (${entry.ref.ats}/${entry.ref.slug}): board API failed - ${outcome.error}`);
      jobs = fallbackJobsFromHits(entry.ref, matchedUrls, hitsByUrl, entry.name);
      outcome.openings = jobs.length;
      if (jobs.length) {
        report.notes.push(
          `${outcome.company}'s board API was unreachable (${outcome.error}); kept the ${jobs.length} ` +
            'posting(s) search found, with shorter descriptions.',
        );
      }
    }

    const company = await registerCompany(entry.ref, outcome.company);
    if (company.created) report.companiesRegistered++;

    for (const job of jobs) {
      const canonical = canonicalUrl(job.url);
      // Keep what the search actually matched; keep a sibling only if it looks
      // like a role the plan asked for.
      const wanted = matchedUrls.has(canonical) || titleMatchesPlan(job.title, plan.roleTitles);
      if (!wanted) continue;

      report.jobsSeen++;
      if (existing.has(canonical)) {
        report.skippedAlreadySeen++;
        continue;
      }
      existing.add(canonical);

      const named: DiscoveredJob = { ...job, companyName: outcome.company || job.companyName };
      const lex = scoreLexically(named, scoring);
      try {
        const lead = await prisma.jobLead.create({
          data: {
            profileId,
            companyId: company.id,
            url: job.url,
            ats: job.ats,
            title: job.title,
            companyName: named.companyName,
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
        outcome.kept++;
        fresh.push({ id: lead.id, job: named, lexScore: lex.score });
      } catch (err) {
        report.errors.push({ where: `saving ${job.url}`, error: (err as Error).message });
      }
    }
  }

  log(`${report.newLeads} new lead(s) from ${report.jobsSeen} relevant posting(s)`);

  // ---- 4. read the most promising in full ----------------------------------
  if (fresh.length && deepScoreTop > 0) {
    report.deepScored = await deepScore(profileId, fresh, deepScoreTop, scoring, report);
  }

  // Re-rank what was already in the queue too. Leads stored before the resume
  // was uploaded - or before the scorer learned to use it - keep the score
  // they were created with unless something goes back for them.
  report.rerankedExisting = await rescoreLexically(profileId);

  return report;
}

/**
 * Register the company so the per-company crawler picks it up from now on.
 *
 * This is what stops search from being a parallel universe. Search finds Acme
 * once; after that Acme is a board like any other you added by hand, its
 * future postings arrive through the ordinary crawl, and no credits are spent
 * re-finding it.
 */
async function registerCompany(
  ref: BoardRef,
  name: string,
): Promise<{ id: string; created: boolean }> {
  const found = await prisma.company.findUnique({
    where: { source_handle: { source: ref.ats, handle: ref.slug } },
  });
  if (found) return { id: found.id, created: false };
  const created = await prisma.company.create({
    data: { name, source: ref.ats, handle: ref.slug, enabled: true, lastCrawledAt: new Date() },
  });
  return { id: created.id, created: true };
}

async function deepScore(
  profileId: string,
  fresh: { id: string; job: DiscoveredJob; lexScore: number }[],
  top: number,
  scoring: ScoringContext,
  report: JobSearchReport,
): Promise<number> {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    include: { facts: true },
  });
  if (!profile) return 0;

  const candidateContext = renderCandidateContext(profile, profile.resumeText);
  const constraints = extractCandidateConstraints(profile);
  const preferences = await buildPreferences(profileId);
  const rejectionHistory = await buildRejectionHistory(profileId);

  let done = 0;
  const shortlist = [...fresh].sort((a, b) => b.lexScore - a.lexScore).slice(0, top);
  for (const entry of shortlist) {
    try {
      const fit = await assessFit({
        candidateContext,
        preferences,
        rejectionHistory,
        job: entry.job,
      });
      if (!fit) continue;

      // Both hard rules, on the same path every other scorer uses. This used
      // to be the only place the experience check ran, and it subtracted from
      // the score rather than blocking - so a model's 90 became a 33 and still
      // outranked jobs that were genuinely open.
      const adjustedFit = applyHardRules(fit, { 
        candidateYears: constraints.candidateYears, 
        needsSponsorship: constraints.needsSponsorship,
        salaryExpectations: constraints.salaryExpectations,
        job: entry.job 
      });

      const lex = scoreLexically(entry.job, scoring);
      const blended = blendScores(adjustedFit, lex);
      await prisma.jobLead.update({
        where: { id: entry.id },
        data: {
          score: blended,
          scoreReasons: serialiseReasons(lex, adjustedFit) as Prisma.InputJsonValue,
          deepScored: true,
          scoredAt: new Date(),
        },
      });
      done++;
    } catch (err) {
      // The lead keeps its lexical score and can be re-scored later; losing it
      // over a scoring hiccup would be much worse.
      report.errors.push({ where: `scoring ${entry.job.title}`, error: (err as Error).message });
    }
  }
  return done;
}

/** Leads built from the search result alone, when a board API will not answer. */
function fallbackJobsFromHits(
  ref: BoardRef,
  matchedUrls: Set<string>,
  hitsByUrl: Map<string, SearchHit>,
  companyName?: string,
): DiscoveredJob[] {
  const out: DiscoveredJob[] = [];
  for (const url of matchedUrls) {
    const hit = hitsByUrl.get(url);
    if (!hit) continue;
    const hitRef = parseBoardUrl(hit.url);
    if (!hitRef || boardKey(hitRef) !== boardKey(ref)) continue;
    out.push({
      // Upgraded, but not canonicalised: this URL is what the browser will
      // actually open, and stripping the query would break a Greenhouse embed
      // link, which carries the board and the job in `?for=` and `?token=`.
      url: preferHttps(hit.url),
      ats: ref.ats,
      title: cleanHitTitle(hit.title) || hit.url,
      companyName: companyName ?? ref.slug,
      remote: /\bremote\b/i.test(`${hit.title} ${hit.description}`),
      // Search descriptions are a couple of sentences, so this lead gets a
      // weaker score than a hydrated one. Better than losing it.
      descriptionText: hit.description,
    });
  }
  return out;
}

/** ATS page titles are wrapped in boilerplate that would end up in the queue. */
function cleanHitTitle(title: string): string {
  return title
    .replace(/^job application for\s+/i, '')
    .replace(/\s+at\s+[^|@]+$/i, '')
    .replace(/\s*[@|·]\s*.*$/, '')
    .replace(/\s*-\s*careers?\s*$/i, '')
    .trim();
}

/**
 * One URL, one lead.
 *
 * Search hands back `http://job-boards.greenhouse.io/fal/jobs/4009193009`
 * while the board API returns the same posting over https, often with a
 * tracking parameter and sometimes a trailing slash. Compared raw, those are
 * four different jobs, and the queue fills up with the same posting.
 */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return raw.trim();
  }
}

/** Search hands back http:// for pages that are served over https. */
function preferHttps(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.toString();
  } catch {
    return raw;
  }
}

const isTransient = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { transient?: boolean }).transient === true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Progress on stdout.
 *
 * A search run takes tens of seconds and, until it finishes, the UI can only
 * say "Searching...". Without this the honest report from a user is "it is not
 * doing anything", and there is nowhere to look to find out otherwise.
 */
const log = (message: string) => process.stdout.write(`[find] ${message}\n`);

export { isFirecrawlConfigured };
