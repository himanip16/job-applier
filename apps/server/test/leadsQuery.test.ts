import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The queue as a thing you can navigate.
 *
 * Sixty leads on one unsorted, unfilterable page is fine on the day you set
 * the app up and useless a week later, and "rescore everything" is the wrong
 * button because a model pass costs a call per posting. So: pages, filters,
 * a sort, and a rescore that reads exactly what you ticked.
 */

const generateMock = vi.fn();
vi.mock('../src/llm/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/client.js')>();
  return { ...actual, generate: (...args: unknown[]) => generateMock(...args) };
});

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { registerDiscoveryRoutes, MAX_RESCORE_BATCH } = await import('../src/routes/discovery.js');
const Fastify = (await import('fastify')).default;

type App = ReturnType<typeof Fastify>;

let app: App;
let profileId: string;

/** Nine leads, deliberately not in score, name or date order. */
const SEED = [
  { title: 'Staff Backend Engineer', companyName: 'Acme', score: 91, remote: true, deep: true },
  { title: 'Senior Platform Engineer', companyName: 'Zebra', score: 84, remote: false, deep: true },
  { title: 'Backend Engineer, Payments', companyName: 'Mochi', score: 72, remote: true, deep: false },
  { title: 'Software Engineer II', companyName: 'Acme', score: 68, remote: false, deep: false },
  { title: 'Data Engineer', companyName: 'Bolt', score: 54, remote: true, deep: false },
  { title: 'Frontend Engineer', companyName: 'Zebra', score: 41, remote: false, deep: false },
  { title: 'Site Reliability Engineer', companyName: 'Bolt', score: 33, remote: true, deep: false },
  { title: 'Support Engineer', companyName: 'Mochi', score: 20, remote: false, deep: false },
  { title: 'Sales Engineer', companyName: 'Acme', score: 11, remote: false, deep: false },
];

beforeEach(async () => {
  generateMock.mockReset();
  await prisma.jobLead.deleteMany({});
  await prisma.preferenceSignal.deleteMany({});
  await prisma.profile.deleteMany({});

  const p = await prisma.profile.create({
    data: {
      email: `leads-${Date.now()}@example.com`,
      fullName: 'Test Person',
      firstName: 'Test',
      lastName: 'Person',
      resumeText: 'Backend engineer. Go, Postgres, payments.',
    },
  });
  profileId = p.id;

  let i = 0;
  for (const s of SEED) {
    await prisma.jobLead.create({
      data: {
        profileId,
        url: `https://job-boards.greenhouse.io/${s.companyName.toLowerCase()}/jobs/${i}`,
        ats: 'greenhouse',
        title: s.title,
        companyName: s.companyName,
        location: s.remote ? 'Remote - US' : 'Bengaluru, India',
        remote: s.remote,
        descriptionText: `We need someone to work on ${s.title}.`,
        score: s.score,
        deepScored: s.deep,
        // Ascending, so "newest first" is the reverse of this list.
        discoveredAt: new Date(2026, 0, 1 + i),
      },
    });
    i++;
  }

  app = Fastify();
  registerDiscoveryRoutes(app, async () => ({ id: profileId }));
  await app.ready();
});

interface LeadPage {
  leads: { id: string; title: string; companyName: string; score: number }[];
  total: number;
  page: number;
  pages: number;
  strong: number;
  maxRescoreBatch: number;
}

async function leads(query = ''): Promise<LeadPage> {
  const res = await app.inject({ method: 'GET', url: `/api/leads${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as LeadPage;
}

describe('paging through the queue', () => {
  it('defaults to the highest scoring first, and says how many there are', async () => {
    const page = await leads();
    expect(page.total).toBe(9);
    expect(page.pages).toBe(1);
    expect(page.leads.map((l) => l.score)).toEqual([91, 84, 72, 68, 54, 41, 33, 20, 11]);
  });

  it('cuts the list into pages that do not overlap or drop anyone', async () => {
    const first = await leads('?limit=4&page=1');
    const second = await leads('?limit=4&page=2');
    const third = await leads('?limit=4&page=3');

    expect([first.pages, first.total]).toEqual([3, 9]);
    expect(first.leads).toHaveLength(4);
    expect(third.leads).toHaveLength(1);

    const seen = [...first.leads, ...second.leads, ...third.leads].map((l) => l.id);
    expect(new Set(seen).size).toBe(9);
  });

  it('clamps a page past the end instead of showing an empty one', async () => {
    // Deciding on the last lead of the last page must not strand you on a
    // blank page that reads as "everything is gone".
    const page = await leads('?limit=4&page=99');
    expect(page.page).toBe(3);
    expect(page.leads).toHaveLength(1);
  });

  it('counts the strong matches across every page, not just the one on screen', async () => {
    const page = await leads('?limit=2');
    expect(page.leads).toHaveLength(2);
    // 91, 84 and 72 are at or above the threshold; only two are on this page.
    expect(page.strong).toBe(3);
  });
});

describe('sorting', () => {
  it('sorts by score either way', async () => {
    expect((await leads('?sort=score&dir=asc')).leads[0]!.score).toBe(11);
    expect((await leads('?sort=score&dir=desc')).leads[0]!.score).toBe(91);
  });

  it('sorts by company, then by title within a company', async () => {
    const page = await leads('?sort=company&dir=asc');
    expect(page.leads.map((l) => l.companyName)).toEqual([
      'Acme', 'Acme', 'Acme', 'Bolt', 'Bolt', 'Mochi', 'Mochi', 'Zebra', 'Zebra',
    ]);
    expect(page.leads.slice(0, 3).map((l) => l.title)).toEqual([
      'Sales Engineer',
      'Software Engineer II',
      'Staff Backend Engineer',
    ]);
  });

  it('sorts by when it was found', async () => {
    const newest = await leads('?sort=discovered&dir=desc');
    expect(newest.leads[0]!.title).toBe('Sales Engineer');
    const oldest = await leads('?sort=discovered&dir=asc');
    expect(oldest.leads[0]!.title).toBe('Staff Backend Engineer');
  });
});

describe('filtering', () => {
  it('finds by title, company or location, case-insensitively', async () => {
    expect((await leads('?q=backend')).leads.map((l) => l.title)).toEqual([
      'Staff Backend Engineer',
      'Backend Engineer, Payments',
    ]);
    expect((await leads('?q=zebra')).total).toBe(2);
    expect((await leads('?q=bengaluru')).total).toBe(5);
  });

  it('filters on remote, on a score floor and on whether it was read in full', async () => {
    expect((await leads('?remote=yes')).total).toBe(4);
    expect((await leads('?remote=no')).total).toBe(5);
    expect((await leads('?minScore=70')).total).toBe(3);
    expect((await leads('?depth=deep')).total).toBe(2);
    expect((await leads('?depth=quick')).total).toBe(7);
  });

  it('combines filters, and reports the total for the filtered set', async () => {
    const page = await leads('?remote=yes&minScore=50&limit=1');
    // 91, 84(not remote), 72, 54 -> three remote leads at or above 50.
    expect(page.total).toBe(3);
    expect(page.pages).toBe(3);
    expect(page.leads).toHaveLength(1);
  });
});

describe('rescoring only what was picked', () => {
  function modelSays(score: number) {
    return {
      score,
      verdict: 'Worth a look.',
      seniorityFit: 'right',
      forIt: ['Backend depth'],
      againstIt: [],
    };
  }

  it('reads exactly the leads it was given, and leaves the rest alone', async () => {
    const all = await leads();
    // Deliberately two in-domain, non-remote leads. The hard rules block
    // another profession's job outright and block a US posting that never
    // mentions sponsorship, and the seed contains both - "Sales Engineer" and
    // the "Remote - US" ones - so picking those would be testing the rules
    // rather than the batching.
    const [pickedA, pickedB] = [all.leads[3]!, all.leads[5]!];
    const untouched = all.leads[6]!;

    generateMock.mockResolvedValue(modelSays(88));

    const res = await app.inject({
      method: 'POST',
      url: '/api/leads/rescore',
      payload: { ids: [pickedA.id, pickedB.id] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rescored: number; results: { id: string; ok: boolean }[] };
    expect(body.rescored).toBe(2);

    // Two calls, not nine: this is the whole point of picking.
    expect(generateMock).toHaveBeenCalledTimes(2);

    const after = await prisma.jobLead.findMany({
      where: { id: { in: [pickedA.id, pickedB.id, untouched.id] } },
    });
    for (const lead of after) {
      if (lead.id === untouched.id) {
        expect(lead.deepScored).toBe(false);
        expect(lead.score).toBe(untouched.score);
      } else {
        expect(lead.deepScored).toBe(true);
        expect(lead.score).toBeGreaterThan(60);
      }
    }
  });

  it('reports each lead separately, so one bad posting does not lose the batch', async () => {
    const all = await leads();
    const good = all.leads[0]!;
    const blank = await prisma.jobLead.create({
      data: {
        profileId,
        url: 'https://job-boards.greenhouse.io/acme/jobs/blank',
        ats: 'greenhouse',
        title: 'Mystery Role',
        companyName: 'Acme',
        descriptionText: null,
        score: 5,
      },
    });

    generateMock.mockResolvedValue(modelSays(77));

    const res = await app.inject({
      method: 'POST',
      url: '/api/leads/rescore',
      payload: { ids: [good.id, blank.id, 'no-such-lead'] },
    });
    const body = res.json() as {
      rescored: number;
      results: { id: string; ok: boolean; reason?: string; error?: string }[];
    };

    expect(body.rescored).toBe(1);
    expect(body.results).toHaveLength(3);
    // Answered in the order they were asked for, so the UI can line the
    // results up against the boxes that were ticked.
    expect(body.results.map((r) => r.id)).toEqual([good.id, blank.id, 'no-such-lead']);
    expect(body.results[1]!.reason).toBe('no-description');
    expect(body.results[2]!.reason).toBe('not-found');
    // The one with no description was never sent to the model.
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a batch larger than one press should ever ask for', async () => {
    const ids = Array.from({ length: MAX_RESCORE_BATCH + 1 }, (_, i) => `id-${i}`);
    const res = await app.inject({ method: 'POST', url: '/api/leads/rescore', payload: { ids } });
    expect(res.statusCode).toBe(500);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('still scores one lead through its own route', async () => {
    const all = await leads();
    generateMock.mockResolvedValue(modelSays(95));
    const res = await app.inject({ method: 'POST', url: `/api/leads/${all.leads[5]!.id}/rescore` });
    expect(res.statusCode).toBe(200);
    const { lead } = res.json() as { lead: { deepScored: boolean; score: number } };
    expect(lead.deepScored).toBe(true);
    expect(lead.score).toBeGreaterThan(60);
  });

  it('says why, when the model will not answer', async () => {
    const all = await leads();
    generateMock.mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: `/api/leads/${all.leads[0]!.id}/rescore` });
    expect(res.statusCode).toBe(502);
  });
});
