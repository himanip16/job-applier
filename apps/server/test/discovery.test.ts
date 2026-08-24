import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Discovery has two halves worth testing without a network: the source parsers
 * (which turn each board's idiosyncratic JSON into one shape) and the learner
 * (which has to actually move rankings in response to what you reject).
 */

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { greenhouseSource, leverSource, ashbySource } = await import('../src/discovery/sources.js');
const { scoreLexically, learnFromDecision, loadSignals, loadScoringContext, jobTerms } = await import(
  '../src/discovery/scoring.js'
);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockJson(payload: unknown) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('board API parsers', () => {
  it('reads a Greenhouse board listing, HTML description and all', async () => {
    mockJson({
      jobs: [
        {
          id: 123,
          title: 'Staff Backend Engineer',
          absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/123',
          updated_at: '2026-08-01T10:00:00Z',
          location: { name: 'Remote - US' },
          content: '<p>Build <strong>payment</strong> systems in Go.</p><ul><li>Postgres</li></ul>',
        },
      ],
    });

    const [job] = await greenhouseSource.fetchJobs('acme');
    expect(job).toMatchObject({
      ats: 'greenhouse',
      title: 'Staff Backend Engineer',
      url: 'https://job-boards.greenhouse.io/acme/jobs/123',
      location: 'Remote - US',
      remote: true,
    });
    // HTML is flattened to readable text, not left as tags.
    expect(job!.descriptionText).toContain('Build payment systems in Go.');
    expect(job!.descriptionText).not.toMatch(/<[a-z]/i);
  });

  it('reads a Lever posting, including the extra list sections', async () => {
    mockJson([
      {
        id: 'abc',
        text: 'Senior Platform Engineer',
        hostedUrl: 'https://jobs.lever.co/acme/abc',
        createdAt: 1786000000000,
        descriptionPlain: 'Own the platform.',
        categories: { location: 'London, UK' },
        workplaceType: 'onsite',
        lists: [{ text: 'Requirements', content: '<li>Kubernetes</li><li>Go</li>' }],
      },
    ]);

    const [job] = await leverSource.fetchJobs('acme');
    expect(job).toMatchObject({ ats: 'lever', title: 'Senior Platform Engineer', remote: false });
    expect(job!.descriptionText).toContain('Own the platform.');
    // The requirements list is part of the description, not dropped.
    expect(job!.descriptionText).toContain('Requirements');
    expect(job!.descriptionText).toContain('Kubernetes');
  });

  it('reads an Ashby board and respects its explicit remote flag', async () => {
    mockJson({
      jobs: [
        {
          title: 'Backend Engineer',
          location: 'Anywhere',
          isRemote: true,
          jobUrl: 'https://jobs.ashbyhq.com/acme/uuid',
          descriptionPlain: 'Ship things.',
          publishedAt: '2026-07-15T00:00:00Z',
        },
      ],
    });
    const [job] = await ashbySource.fetchJobs('acme');
    expect(job).toMatchObject({ ats: 'ashby', remote: true, title: 'Backend Engineer' });
    expect(job!.postedAt?.getFullYear()).toBe(2026);
  });

  it('surfaces a board error rather than silently returning nothing', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(greenhouseSource.fetchJobs('nonexistent')).rejects.toThrow(/404/);
  });
});

describe('remote detection', () => {
  /**
   * The bug reported live: "Software Engineer 2" at a real company was
   * badged REMOTE while its own rationale - read by the model from the same
   * text - correctly said "Hybrid - Bangalore, India". The badge came from a
   * bare regex match on the word "remote" inside a sentence explaining that
   * the role is hybrid, not remote.
   */
  it('does not call a hybrid role remote because the word appears in the description', async () => {
    mockJson({
      jobs: [
        {
          id: 1,
          title: 'Software Engineer 2',
          absolute_url: 'https://job-boards.greenhouse.io/abnormalsecurity/jobs/1',
          location: { name: 'Bangalore, India' },
          content:
            '<p>This is a hybrid role based in our Bangalore office, three days a week. ' +
            'Remote work is not offered for this position.</p>',
        },
      ],
    });
    const [job] = await greenhouseSource.fetchJobs('abnormalsecurity');
    expect(job!.remote).toBe(false);
  });

  it('still recognises a genuinely unqualified remote role', async () => {
    mockJson({
      jobs: [
        {
          id: 2,
          title: 'Backend Engineer',
          absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/2',
          location: { name: 'Remote' },
          content: '<p>Fully remote team, work from anywhere in the US.</p>',
        },
      ],
    });
    const [job] = await greenhouseSource.fetchJobs('acme');
    expect(job!.remote).toBe(true);
  });

  it('trusts a board’s own hybrid/on-site field over a stray word in free text', async () => {
    mockJson([
      {
        id: 'x',
        text: 'Senior Engineer',
        hostedUrl: 'https://jobs.lever.co/acme/x',
        categories: { location: 'Austin, TX' },
        workplaceType: 'hybrid',
        descriptionPlain: 'Some remote flexibility may be available for senior staff.',
      },
    ]);
    const [job] = await leverSource.fetchJobs('acme');
    expect(job!.remote).toBe(false);
  });

  it('trusts an explicit false from a board even if the location text says otherwise', async () => {
    mockJson({
      jobs: [
        {
          title: 'Support Engineer',
          location: 'Remote-friendly office in Denver',
          isRemote: false,
          jobUrl: 'https://jobs.ashbyhq.com/acme/y',
          descriptionPlain: 'Based in our Denver office.',
        },
      ],
    });
    const [job] = await ashbySource.fetchJobs('acme');
    expect(job!.remote).toBe(false);
  });
});

describe('term extraction', () => {
  it('weights the title over the body and drops filler', () => {
    const terms = jobTerms({
      title: 'Senior Kubernetes Platform Engineer',
      descriptionText: 'kubernetes kubernetes helm helm terraform terraform experience experience',
      location: 'Berlin',
    });
    expect(terms).toContain('kubernetes');
    expect(terms).toContain('platform');
    // "senior", "engineer" and "experience" are role filler, not signal.
    expect(terms).not.toContain('senior');
    expect(terms).not.toContain('engineer');
    expect(terms).not.toContain('experience');
  });
});

describe('learning from what you turn down', () => {
  let profileId: string;

  beforeEach(async () => {
    await prisma.preferenceSignal.deleteMany({});
    await prisma.jobLead.deleteMany({});
    await prisma.profile.deleteMany({});
    const p = await prisma.profile.create({
      data: {
        email: `learner-${Date.now()}@example.com`,
        fullName: 'Test Person',
        firstName: 'Test',
        lastName: 'Person',
      },
    });
    profileId = p.id;
  });

  const onsitePhp = {
    title: 'PHP Developer',
    descriptionText: 'On-site PHP Laravel work in our Slough office. PHP PHP Laravel Laravel onsite onsite.',
    location: 'Slough, UK',
  };
  const remoteGo = {
    title: 'Go Backend Engineer',
    descriptionText: 'Remote Go and Postgres work on distributed payments. Go Go Postgres Postgres remote remote.',
    location: 'Remote',
  };

  it('pushes a rejected job down and a shortlisted one up', async () => {
    const before = scoreLexically(onsitePhp, await loadScoringContext(profileId));
    // No resume and no history, so there is nothing to judge against and
    // the honest answer is the neutral midpoint.
    expect(before.score).toBeCloseTo(50, 0);

    await learnFromDecision({ profileId, job: onsitePhp, accepted: false, reason: 'php and on-site, no thanks' });
    await learnFromDecision({ profileId, job: remoteGo, accepted: true });

    const scoring = await loadScoringContext(profileId);
    const after = scoreLexically(onsitePhp, scoring);
    const good = scoreLexically(remoteGo, scoring);

    expect(after.score).toBeLessThan(before.score);
    expect(good.score).toBeGreaterThan(before.score);
    expect(good.score).toBeGreaterThan(after.score);

    // And it can say why, in terms the candidate would recognise.
    expect(after.negatives).toContain('php');
  });

  it('weighs a stated reason more heavily than the posting it came from', async () => {
    await learnFromDecision({ profileId, job: onsitePhp, accepted: false });
    const withoutReason = (await loadSignals(profileId)).get('php') ?? 0;

    await prisma.preferenceSignal.deleteMany({});
    await learnFromDecision({ profileId, job: onsitePhp, accepted: false, reason: 'php' });
    const withReason = (await loadSignals(profileId)).get('php') ?? 0;

    expect(withReason).toBeLessThan(withoutReason);
  });

  it('learns terms that appear only in the reason, never in the posting', async () => {
    await learnFromDecision({
      profileId,
      job: remoteGo,
      accepted: false,
      // "commute" and "childcare" are nowhere in the description, and are the
      // most informative thing said.
      reason: 'the commute clashes with childcare',
    });
    const signals = await loadSignals(profileId);
    expect(signals.get('commute')).toBeLessThan(0);
    expect(signals.get('childcare')).toBeLessThan(0);
  });

  it('does not learn junk from a free-text reason', async () => {
    await learnFromDecision({
      profileId,
      job: onsitePhp,
      accepted: false,
      reason: 'php and a five day on-site commute, not for me',
    });
    const signals = await loadSignals(profileId);

    // Sentence scaffolding and number words would quietly penalise every
    // unrelated posting that happens to mention a number of days.
    for (const junk of ['five', 'day', 'not', 'for', 'me', 'and']) {
      expect(signals.has(junk), `learned junk term "${junk}"`).toBe(false);
    }
    // Trailing punctuation must not fork one term into two.
    expect(signals.has('commute.')).toBe(false);
    expect(signals.get('commute')).toBeLessThan(0);
    expect(signals.get('php')).toBeLessThan(0);
  });

  it('moves less as evidence accumulates, so one late click cannot swing it', async () => {
    await learnFromDecision({ profileId, job: onsitePhp, accepted: false, reason: 'php' });
    const first = Math.abs((await loadSignals(profileId)).get('php') ?? 0);

    let previous = first;
    for (let i = 0; i < 4; i++) {
      await learnFromDecision({ profileId, job: onsitePhp, accepted: false, reason: 'php' });
      const now = Math.abs((await loadSignals(profileId)).get('php') ?? 0);
      const delta = now - previous;
      expect(delta).toBeLessThan(first);
      previous = now;
    }
    // And it saturates rather than running away.
    expect(previous).toBeLessThanOrEqual(4);
  });

  it('keeps weights bounded so no single term becomes a veto', async () => {
    for (let i = 0; i < 40; i++) {
      await learnFromDecision({ profileId, job: onsitePhp, accepted: false, reason: 'php' });
    }
    const w = (await loadSignals(profileId)).get('php') ?? 0;
    expect(w).toBeGreaterThanOrEqual(-4);
    // Even a heavily-disliked term leaves the score above zero: the model pass
    // gets the final say on a posting, not the bag of words.
    const score = scoreLexically(onsitePhp, await loadScoringContext(profileId)).score;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(20);
  });
});

describe('descriptions that arrive as escaped HTML', () => {
  /**
   * A live queue had a Roku posting scoring 94% whose top matched terms were
   * `span`, `nbsp`, `data` and `props`. Greenhouse returns `content` as HTML
   * that is itself HTML-escaped, and stripping tags before unescaping left the
   * markup in the text for the scorer to learn from.
   */
  it('strips markup that is itself escaped, not just markup', async () => {
    mockJson({
      jobs: [
      {
        id: 1,
        title: 'Senior Software Engineer - Service mesh',
        absolute_url: 'https://boards.greenhouse.io/roku/jobs/1',
        location: { name: 'Bengaluru, India' },
        // Exactly the shape Greenhouse sends: escaped tags inside real ones.
        content:
          '&lt;p&gt;&lt;span style="color: #333"&gt;Build the service mesh.&lt;/span&gt;&lt;/p&gt;' +
          '&lt;ul&gt;&lt;li&gt;Go and Kubernetes&lt;/li&gt;&lt;/ul&gt;&amp;nbsp;',
      },
      ],
    });

    const jobs = await greenhouseSource.fetchJobs('roku');
    const text = jobs[0]!.descriptionText;

    expect(text).toMatch(/Build the service mesh/);
    expect(text).toMatch(/Go and Kubernetes/);
    for (const junk of ['span', 'nbsp', 'style', 'color', '<p>', '&lt;', '&amp;']) {
      expect(text.toLowerCase()).not.toContain(junk);
    }

    // And nothing markup-shaped survives into what the scorer learns from.
    const terms = jobTerms({ title: jobs[0]!.title, descriptionText: text });
    for (const junk of ['span', 'nbsp', 'div', 'style', 'props']) {
      expect(terms).not.toContain(junk);
    }
  });

  it('keeps a weight learned on markup from ever scoring again', async () => {
    // The parser is fixed, but weights already in the database are not, and a
    // stored weight on "span" is not something anyone can see to delete.
    const p = await prisma.profile.create({
      data: {
        email: `markup-${Date.now()}@example.com`,
        fullName: 'T', firstName: 'T', lastName: 'T',
      },
    });
    await prisma.preferenceSignal.create({
      data: { profileId: p.id, term: 'span', weight: 3.5, evidence: 9, origin: 'LEXICAL' },
    });
    await prisma.preferenceSignal.create({
      data: { profileId: p.id, term: 'kubernetes', weight: 1.2, evidence: 3, origin: 'LEXICAL' },
    });

    const signals = await loadSignals(p.id);
    expect(signals.has('span')).toBe(false);
    expect(signals.get('kubernetes')).toBeCloseTo(1.2);
  });
});
