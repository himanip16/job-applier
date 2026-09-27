import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Planning fallback tests must not call a paid model, including when a key is
// present in the test database's saved settings.
vi.mock('../src/llm/client.js', () => ({
  isConfigured: () => false,
  generate: vi.fn(),
  describeLlmError: (error: unknown) => String(error),
}));

/**
 * The search path, end to end, without a network.
 *
 * The thing worth proving here is the shape of the design: a web search gives
 * us URLs, and a URL is enough to reach a board API that hands back every
 * opening at that company with a full description. One search hit becoming
 * four leads is the whole reason this is not a scraper.
 */

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { parseBoardUrl, companyNameFromTitle, boardKey, prettifySlug } = await import(
  '../src/discovery/boardUrls.js'
);
const { titleMatchesPlan, buildSearchPlan } = await import(
  '../src/discovery/searchQueries.js'
);
const { findJobs, canonicalUrl } = await import('../src/discovery/findJobs.js');
const { firecrawlSearch, FirecrawlError } = await import('../src/discovery/firecrawl.js');
const { setSetting, clearSetting, loadSettings } = await import('../src/lib/secrets.js');

describe('recognising a posting URL', () => {
  it('reduces every board we can apply on to an ats and a slug', () => {
    const cases: [string, string, string][] = [
      ['https://job-boards.greenhouse.io/mercury/jobs/6118243004', 'greenhouse', 'mercury'],
      ['http://job-boards.greenhouse.io/fal/jobs/4009193009', 'greenhouse', 'fal'],
      ['https://boards.greenhouse.io/acme/jobs/12345', 'greenhouse', 'acme'],
      ['https://jobs.lever.co/plaid/6ca0ab85-77a7-468f-a13f-4b4ad1e264ee', 'lever', 'plaid'],
      ['https://jobs.ashbyhq.com/Nash/5078366e-db73-45a4-b9cb-23162d3bc28b', 'ashby', 'Nash'],
      ['https://apply.workable.com/acme/j/ABCDEF123/', 'workable', 'acme'],
    ];
    for (const [url, ats, slug] of cases) {
      expect(parseBoardUrl(url), url).toEqual({ ats, slug });
    }
  });

  it('reads the board out of a Greenhouse embed, which puts it in the query string', () => {
    // Without this the slug parses as "embed" and we go asking Greenhouse for
    // the openings at a company called embed.
    expect(parseBoardUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=99')).toEqual({
      ats: 'greenhouse',
      slug: 'acme',
    });
    expect(parseBoardUrl('https://boards.greenhouse.io/embed/job_app?token=99')).toBeNull();
  });

  it('rejects anything we could not actually submit an application to', () => {
    for (const url of [
      'https://www.linkedin.com/jobs/view/12345',
      'https://www.indeed.com/viewjob?jk=abc',
      'https://example.com/careers/backend-engineer',
      'https://job-boards.greenhouse.io/',
      'not a url at all',
    ]) {
      expect(parseBoardUrl(url), url).toBeNull();
    }
  });

  it('treats the same board written two ways as one board', () => {
    const a = parseBoardUrl('https://job-boards.greenhouse.io/Acme/jobs/1')!;
    const b = parseBoardUrl('http://job-boards.greenhouse.io/acme/jobs/2')!;
    expect(boardKey(a)).toBe(boardKey(b));
  });
});

describe('naming the company', () => {
  it('takes the real name out of the page title rather than showing a slug', () => {
    // Verbatim titles from a live search; the slugs are what the board API
    // would have given us instead.
    expect(
      companyNameFromTitle('Job Application for Senior Backend Engineer at Mochi Health', 'mochihealth'),
    ).toBe('Mochi Health');
    expect(companyNameFromTitle('Senior Backend Engineer @ Nash', 'Nash')).toBe('Nash');
    expect(companyNameFromTitle('Software Engineer - Careers at Acme Corp', 'acme')).toBe('Acme Corp');
  });

  it('falls back to the slug rather than inventing word breaks', () => {
    // "mochihealth" -> "Mochi Health" needs a dictionary, and a wrong split
    // reads worse than a lowercase slug.
    expect(companyNameFromTitle('Senior Backend Engineer', 'mochihealth')).toBe('Mochihealth');
    expect(prettifySlug('acme-labs')).toBe('Acme Labs');
  });
});

describe('one URL, one lead', () => {
  it('collapses the scheme, host case, trailing slash and tracking parameters', () => {
    const forms = [
      'http://job-boards.greenhouse.io/fal/jobs/4009193009',
      'https://job-boards.greenhouse.io/fal/jobs/4009193009',
      'https://job-boards.greenhouse.io/fal/jobs/4009193009/',
      'https://job-boards.greenhouse.io/fal/jobs/4009193009?gh_src=abc',
      'https://job-boards.greenhouse.io/fal/jobs/4009193009#apply',
    ];
    const canonical = new Set(forms.map(canonicalUrl));
    expect(canonical.size).toBe(1);
  });
});

describe('keeping the siblings that are relevant', () => {
  it('keeps roles matching the plan and drops the rest of the company', () => {
    const plan = ['Senior Backend Engineer', 'Staff Software Engineer, Payments'];
    expect(titleMatchesPlan('Senior Backend Engineer', plan)).toBe(true);
    expect(titleMatchesPlan('Backend Engineer II', plan)).toBe(true);
    expect(titleMatchesPlan('Staff Engineer, Payments Platform', plan)).toBe(true);
    // The reason the gate exists at all.
    expect(titleMatchesPlan('Warehouse Associate', plan)).toBe(false);
    expect(titleMatchesPlan('VP of Sales', plan)).toBe(false);
    expect(titleMatchesPlan('Technical Recruiter', plan)).toBe(false);
  });

  it('does not wave through an entire company when every word is generic', () => {
    // "Software Engineer" is all filler tokens. Matching on what survives the
    // stoplist would leave nothing to match on, so it falls back to the phrase.
    expect(titleMatchesPlan('Senior Software Engineer', ['Software Engineer'])).toBe(true);
    expect(titleMatchesPlan('Head of People', ['Software Engineer'])).toBe(false);
  });

  it('matches nothing when there is no plan, rather than everything', () => {
    expect(titleMatchesPlan('Backend Engineer', [])).toBe(false);
  });
});

describe('the relevance gate against a real company board', () => {
  // Greenhouse board "mercury", read live. One search hit here offers 56
  // openings; the gate decides which of them a backend engineer should see.
  const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
  const { titles } = JSON.parse(
    readFileSync(path.join(fixtures, 'mercury-board-titles.json'), 'utf8'),
  ) as { titles: string[] };

  const kept = (plan: string[]) => titles.filter((t) => titleMatchesPlan(t, plan));

  it('picks the backend roles out of fifty-five and leaves the rest', () => {
    const result = kept(['Senior Backend Engineer']);
    expect(result).toEqual(['Senior Backend Engineer - Product']);
  });

  it('does not offer a lawyer job to an engineer who searched for payments', () => {
    // The failure this gate was tightened for. "Staff Software Engineer,
    // Payments" shares exactly one distinctive word with "Counsel, Product &
    // Regulatory - Payments & AML", and matching on it alone was enough.
    const result = kept(['Staff Software Engineer, Payments']);
    expect(result).not.toContain('Counsel, Product & Regulatory - Payments & AML');
    expect(result).not.toContain('Senior Product & Regulatory Counsel - Investment Products');
    expect(result).not.toContain('Payment Operations Lead');
  });

  it('keeps the whole engineering ladder when the plan asks for it', () => {
    const result = kept(['Senior Software Engineer', 'Software Engineer']);
    expect(result).toContain('Senior Software Engineer - Fraud');
    expect(result).toContain('Software Engineer - Infrastructure');
    expect(result).toContain('Software Engineer - Product');
    // Still not the sales org.
    expect(result).not.toContain('Sales Development Representative');
    expect(result).not.toContain('Senior HRIS Analyst');
    expect(result).not.toContain('Staff Brand Designer');
  });

  it('never lets one company flood the queue', () => {
    // The number that matters: a plausible plan must not turn one search hit
    // into most of a 55-role board.
    const result = kept(['Senior Backend Engineer', 'Staff Software Engineer, Payments']);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

describe('the Firecrawl client', () => {
  const realFetch = globalThis.fetch;
  const realEnvKey = process.env.FIRECRAWL_API_KEY;

  /**
   * Set the key the way the app does.
   *
   * `config.firecrawlApiKey` is a getter over the settings overlay now, so a
   * test cannot assign to it - which is the point: a key saved from the UI has
   * to reach the same call sites a key in .env does, and this exercises that.
   */
  const withKey = async (key: string) => {
    delete process.env.FIRECRAWL_API_KEY;
    await loadSettings();
    if (key) await setSetting('FIRECRAWL_API_KEY', key);
    else await clearSetting('FIRECRAWL_API_KEY');
  };
  const restore = async () => {
    globalThis.fetch = realFetch;
    await clearSetting('FIRECRAWL_API_KEY');
    if (realEnvKey) process.env.FIRECRAWL_API_KEY = realEnvKey;
    await loadSettings();
  };

  it('says what to do when there is no key, instead of failing at the socket', async () => {
    await withKey('');
    try {
      await expect(firecrawlSearch('backend engineer')).rejects.toThrow(/No Firecrawl key configured/i);
    } finally {
      await restore();
    }
  });

  it('uses a key saved from the settings page, not just one in .env', async () => {
    // The regression this guards: config read the environment once at import,
    // so a key typed into the UI did nothing until the server was restarted.
    await withKey('saved-from-ui');
    let seenAuth = '';
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      seenAuth = (init as { headers: Record<string, string> }).headers.authorization ?? '';
      return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await firecrawlSearch('x');
      expect(seenAuth).toBe('Bearer saved-from-ui');
    } finally {
      await restore();
    }
  });

  it('sends the domain filter and reads the results back', async () => {
    await withKey('test-key');
    let sent: { url: string; body: Record<string, unknown>; auth: string } | null = null;
    globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
      const req = init as { body: string; headers: Record<string, string> };
      sent = {
        url: String(url),
        body: JSON.parse(req.body) as Record<string, unknown>,
        auth: req.headers.authorization ?? '',
      };
      return new Response(
        JSON.stringify({
          success: true,
          creditsUsed: 2,
          data: { web: [{ url: 'https://jobs.lever.co/acme/abc', title: 'T', description: 'D' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      const res = await firecrawlSearch('senior backend engineer go', {
        includeDomains: ['jobs.lever.co'],
        limit: 5,
      });
      expect(res.hits).toHaveLength(1);
      expect(res.creditsUsed).toBe(2);
      const call = sent as unknown as { url: string; body: Record<string, unknown>; auth: string };
      expect(call.url).toMatch(/\/v2\/search$/);
      expect(call.auth).toBe('Bearer test-key');
      expect(call.body.includeDomains).toEqual(['jobs.lever.co']);
      expect(call.body.limit).toBe(5);
    } finally {
      await restore();
    }
  });

  it('distinguishes an exhausted balance from a rate limit, because only one is worth retrying', async () => {
    await withKey('test-key');
    try {
      globalThis.fetch = vi.fn(
        async () => new Response(JSON.stringify({ error: 'Insufficient credits' }), { status: 402 }),
      ) as unknown as typeof fetch;
      const outOfCredits = await firecrawlSearch('x').catch((e: unknown) => e);
      expect(outOfCredits).toBeInstanceOf(FirecrawlError);
      expect((outOfCredits as InstanceType<typeof FirecrawlError>).transient).toBe(false);
      expect((outOfCredits as Error).message).toMatch(/out of credits/i);

      globalThis.fetch = vi.fn(
        async () => new Response('slow down', { status: 429 }),
      ) as unknown as typeof fetch;
      const limited = await firecrawlSearch('x').catch((e: unknown) => e);
      expect((limited as InstanceType<typeof FirecrawlError>).transient).toBe(true);
    } finally {
      await restore();
    }
  });

  it('reports a bad key as a config problem, not a transient one', async () => {
    await withKey('test-key');
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    ) as unknown as typeof fetch;
    try {
      const err = await firecrawlSearch('x').catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/Firecrawl rejected the API key/i);
      expect((err as InstanceType<typeof FirecrawlError>).transient).toBe(false);
    } finally {
      await restore();
    }
  });
});

describe('a full search run', () => {
  let profileId: string;

  beforeEach(async () => {
    await prisma.jobLead.deleteMany({});
    await prisma.preferenceSignal.deleteMany({});
    await prisma.company.deleteMany({});
    await prisma.profile.deleteMany({});
    const p = await prisma.profile.create({
      data: {
        email: `searcher-${Date.now()}@example.com`,
        fullName: 'Test Person',
        firstName: 'Test',
        lastName: 'Person',
        city: 'San Francisco',
        countryCode: 'US',
        resumeText: '9 years building distributed payment systems in Go and Postgres.',
      },
    });
    profileId = p.id;
  });

  const plan = async () => ({
    roleTitles: ['Senior Backend Engineer'],
    queries: ['senior backend engineer go payments san francisco'],
    country: 'US',
    source: 'profile' as const,
    notes: [],
  });

  /** The target list, cut down to one company so the assertions stay readable. */
  const acmeOnly = () => [
    {
      company: 'Acme Corp',
      domain: 'acme.com',
      source: 'greenhouse',
      handle: 'acme',
      tier: 'bigtech',
      sde2_ctc_lpa: '70-150',
      india_locations: 'Bangalore',
    },
  ];

  const acmeBoard = async () => [
    {
      url: 'https://job-boards.greenhouse.io/acme/jobs/1001',
      ats: 'greenhouse',
      title: 'Senior Backend Engineer',
      companyName: 'acme',
      location: 'San Francisco, CA',
      remote: false,
      descriptionText: 'Go and Postgres on the payments ledger. '.repeat(20),
    },
    {
      url: 'https://job-boards.greenhouse.io/acme/jobs/1002',
      ats: 'greenhouse',
      title: 'Senior Backend Engineer, Ledger',
      companyName: 'acme',
      location: 'Remote',
      remote: true,
      descriptionText: 'Distributed systems and settlement. '.repeat(20),
    },
    {
      url: 'https://job-boards.greenhouse.io/acme/jobs/1003',
      ats: 'greenhouse',
      title: 'Warehouse Associate',
      companyName: 'acme',
      location: 'Sparks, NV',
      remote: false,
      descriptionText: 'Lift boxes. '.repeat(20),
    },
    {
      url: 'https://job-boards.greenhouse.io/acme/jobs/1004',
      ats: 'greenhouse',
      title: 'Technical Recruiter',
      companyName: 'acme',
      location: 'San Francisco, CA',
      remote: false,
      descriptionText: 'Hire engineers. '.repeat(20),
    },
  ];

  it('keeps only the openings at a target company that match the plan', async () => {
    const report = await findJobs(profileId, {
      deepScoreTop: 0,
      deps: { plan, companies: acmeOnly, fetchCompany: acmeBoard },
    });

    expect(report.newLeads).toBe(2);
    expect(report.creditsUsed).toBe(0);
    expect(report.jobsFetched).toBe(4);
    expect(report.jobsSeen).toBe(2);
    expect(report.skippedWrongDomain + report.skippedOffPlan).toBe(2);
    expect([...report.droppedExamples.wrongDomain, ...report.droppedExamples.offPlan]).toContain('Technical Recruiter');

    const leads = await prisma.jobLead.findMany({ where: { profileId }, orderBy: { title: 'asc' } });
    expect(leads.map((l) => l.title)).toEqual([
      'Senior Backend Engineer',
      'Senior Backend Engineer, Ledger',
    ]);
    // The warehouse job and the recruiter role are the reason the gate exists.
    expect(leads.some((l) => /warehouse|recruiter/i.test(l.title))).toBe(false);
    expect(leads[0]!.descriptionText!.length).toBeGreaterThan(200);
  });

  it('passes the role titles and country to the crawler, so big sites search server-side', async () => {
    let seen: unknown;
    await findJobs(profileId, {
      deepScoreTop: 0,
      country: 'IN',
      deps: {
        plan,
        companies: acmeOnly,
        fetchCompany: async (_c, hints) => {
          seen = hints;
          return [];
        },
      },
    });
    expect(seen).toMatchObject({ queries: ['Senior Backend Engineer'], country: { code: 'IN' } });
  });

  it('reads only as many companies as asked, best-paying first', async () => {
    const read: string[] = [];
    const companies = (limit: number) =>
      ['A', 'B', 'C'].slice(0, limit).map((name) => ({ ...acmeOnly()[0]!, company: name, handle: name.toLowerCase() }));
    const report = await findJobs(profileId, {
      deepScoreTop: 0,
      maxBoards: 2,
      deps: { plan, companies, fetchCompany: async (c) => (read.push(c.company), []) },
    });
    expect(read.sort()).toEqual(['A', 'B']);
    expect(report.boards.map((b) => b.company)).toEqual(['A', 'B']);
  });

  it('requests all 100 companies by default and reports unset sources separately from failures', async () => {
    const companies = vi.fn(() => [
      acmeOnly()[0]!,
      { ...acmeOnly()[0]!, company: 'Unset Co', source: 'careers-page', handle: 'unset.example.com' },
    ]);
    const fetchCompany = vi.fn(acmeBoard);
    const report = await findJobs(profileId, { deepScoreTop: 0, deps: { plan, companies, fetchCompany } });
    expect(companies).toHaveBeenCalledWith(100);
    expect(fetchCompany).toHaveBeenCalledTimes(1);
    expect(report.noSource).toEqual(['Unset Co']);
    expect(report.boards.map((b) => b.company)).toEqual(['Acme Corp']);
    expect(report.errors).toEqual([]);
    expect(report.newLeads).toBe(2);
  });

  it('shows the company by its name from the target list, not the board slug', async () => {
    await findJobs(profileId, { deepScoreTop: 0, deps: { plan, companies: acmeOnly, fetchCompany: acmeBoard } });
    const lead = await prisma.jobLead.findFirst({ where: { profileId } });
    expect(lead!.companyName).toBe('Acme Corp');
  });

  it('registers the company so the ordinary crawler owns it from now on', async () => {
    const report = await findJobs(profileId, {
      deepScoreTop: 0,
      deps: { plan, companies: acmeOnly, fetchCompany: acmeBoard },
    });
    expect(report.companiesRegistered).toBe(1);

    const company = await prisma.company.findUnique({
      where: { source_handle: { source: 'greenhouse', handle: 'acme' } },
    });
    expect(company).toBeTruthy();
    expect(company!.enabled).toBe(true);
    expect(company!.name).toBe('Acme Corp');
    const lead = await prisma.jobLead.findFirst({ where: { profileId } });
    expect(lead!.companyId).toBe(company!.id);
  });

  it('never re-offers a job that was already decided', async () => {
    await findJobs(profileId, { deepScoreTop: 0, deps: { plan, companies: acmeOnly, fetchCompany: acmeBoard } });
    await prisma.jobLead.updateMany({
      where: { profileId },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });

    const second = await findJobs(profileId, {
      deepScoreTop: 0,
      deps: { plan, companies: acmeOnly, fetchCompany: acmeBoard },
    });
    expect(second.newLeads).toBe(0);
    expect(second.skippedAlreadySeen).toBe(2);
    expect(await prisma.jobLead.count({ where: { profileId } })).toBe(2);
  });

  it('does not create the same lead twice when the scheme differs', async () => {
    await findJobs(profileId, { deepScoreTop: 0, deps: { plan, companies: acmeOnly, fetchCompany: acmeBoard } });
    const httpBoard = async () =>
      (await acmeBoard()).map((j) => ({ ...j, url: j.url.replace('https://', 'http://') + '/' }));

    const second = await findJobs(profileId, {
      deepScoreTop: 0,
      deps: { plan, companies: acmeOnly, fetchCompany: httpBoard },
    });
    expect(second.newLeads).toBe(0);
    expect(await prisma.jobLead.count({ where: { profileId } })).toBe(2);
  });

  it('keeps going past a company whose site will not answer', async () => {
    const two = () => [
      { ...acmeOnly()[0]!, company: 'Broken Co', handle: 'broken' },
      acmeOnly()[0]!,
    ];
    const report = await findJobs(profileId, {
      deepScoreTop: 0,
      deps: {
        plan,
        companies: two,
        fetchCompany: async (c) => {
          if (c.handle === 'broken') throw new Error('404 Not Found from Greenhouse');
          return acmeBoard();
        },
      },
    });

    expect(report.newLeads).toBe(2);
    expect(report.boards.find((b) => b.company === 'Broken Co')!.error).toMatch(/404/);
    expect(report.errors[0]!.where).toBe('Broken Co');
  });

  it('says so plainly when no target company has a matching opening', async () => {
    const report = await findJobs(profileId, {
      deps: { plan, companies: acmeOnly, fetchCompany: async () => [] },
    });
    expect(report.newLeads).toBe(0);
    expect(report.notes.join(' ')).toMatch(/no matching openings were returned by the 1 companies/i);
  });

  it('reports source limits and every filtering stage without losing surviving jobs', async () => {
    const base = (await acmeBoard())[0]!;
    const report = await findJobs(profileId, {
      country: 'IN', deepScoreTop: 0,
      deps: { plan, companies: acmeOnly, fetchCompany: async (_company, hints) => {
        hints.onWarning?.('Only the first page could be read.');
        return [
          { ...base, location: 'Bengaluru, India', title: 'SDE II', descriptionText: 'Build backend services in Go.' },
          { ...base, url: `${base.url}1`, title: 'Frontend Engineer', location: 'Bengaluru, India' },
          { ...base, url: `${base.url}2`, title: 'Staff Backend Engineer', location: 'Bengaluru, India' },
          { ...base, url: `${base.url}3`, postedAt: new Date('2000-01-01') },
          { ...base, url: `${base.url}4`, location: 'San Francisco, CA' },
        ];
      } },
    });
    expect(report).toMatchObject({ jobsFetched: 5, jobsSeen: 1, newLeads: 1,
      skippedOffPlan: 1, skippedTooSenior: 1, skippedTooOld: 1, skippedOtherCountry: 1 });
    expect(report.boards[0]?.warnings).toContain('Only the first page could be read.');
    expect(report.queries[0]?.hits).toBe(1);
    expect(report.droppedExamples.offPlan).toEqual(['Frontend Engineer']);
    expect(report.droppedExamples.tooSenior).toEqual(['Staff Backend Engineer']);
  });

  it('reads nothing on a dry run, and lists the companies it would read', async () => {
    let calls = 0;
    const report = await findJobs(profileId, {
      dryRun: true,
      deps: { plan, companies: acmeOnly, fetchCompany: async () => (calls++, []) },
    });
    expect(calls).toBe(0);
    expect(report.boards.map((b) => b.company)).toEqual(['Acme Corp']);
    expect(report.notes.join(' ')).toMatch(/^Dry run:/m);
  });
});

describe('planning searches from a profile alone', () => {
  let profileId: string;

  beforeEach(async () => {
    await prisma.jobLead.deleteMany({});
    await prisma.profile.deleteMany({});
  });

  const makeProfile = (resumeText: string | null) =>
    prisma.profile
      .create({
        data: {
          email: `planner-${Date.now()}-${Math.random()}@example.com`,
          fullName: 'Test Person',
          firstName: 'Test',
          lastName: 'Person',
          city: 'San Francisco',
          countryCode: 'US',
          resumeText,
        },
      })
      .then((p) => (profileId = p.id));

  it('derives real queries from a resume with no model key', async () => {
    await makeProfile('9 years building distributed payment systems in Go and Postgres.');
    const plan = await buildSearchPlan(profileId);

    expect(plan.queries.length).toBeGreaterThan(0);
    const joined = plan.queries.join(' | ').toLowerCase();
    // Seniority inferred from the years, stack from the vocabulary, location
    // from the profile.
    expect(joined).toMatch(/staff|senior|principal/);
    expect(joined).toMatch(/\bgo\b|postgres|payments/);
    expect(joined).toMatch(/san francisco/);
    expect(plan.roleTitles.length).toBeGreaterThan(0);
    // Every query has to be a query, not a sentence or a boolean expression.
    for (const q of plan.queries) {
      expect(q).not.toMatch(/site:|inurl:|["']/);
      expect(q.length).toBeLessThanOrEqual(500);
    }
  });

  it('refuses to burn credits when it has nothing to search with', async () => {
    await makeProfile(null);
    // Guessing here would spend real money hunting for a job nobody described.
    await expect(buildSearchPlan(profileId)).rejects.toThrow(/Add your resume/i);
  });

  it('prefers the jobs you actually chose over what your resume implies', async () => {
    await makeProfile('9 years building distributed payment systems in Go and Postgres.');
    await prisma.jobLead.create({
      data: {
        profileId,
        url: 'https://jobs.lever.co/acme/1',
        ats: 'lever',
        title: 'Developer Advocate',
        companyName: 'Acme',
        status: 'SHORTLISTED',
        decidedAt: new Date(),
      },
    });

    const plan = await buildSearchPlan(profileId);
    expect(plan.roleTitles).toContain('Developer Advocate');
  });
});
