import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  profileVocabulary,
  scoreLexically,
  blendScores,
  type FitAssessment,
  type ScoringContext,
} from '../src/discovery/scoring.js';

/**
 * What a crawl hands you before any model has read anything.
 *
 * This used to be worthless. The cheap pass was built only from learned
 * preference weights, so a profile that had not rejected anything yet scored
 * every single posting at exactly 50 - a backend role and a sales role tied to
 * the decimal - and "read the top 15 in full" really meant "read the first 15
 * that happened to be stored". The queue looked ranked and was not, which is
 * worse than looking unranked.
 *
 * So the constants that turn resume overlap into a 0-100 number are checked
 * against real data rather than asserted: every open title on Mercury's board,
 * read verbatim from Greenhouse, ranked for one backend engineer.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const titles = (
  JSON.parse(
    readFileSync(path.resolve(here, '../../../fixtures/mercury-board-titles.json'), 'utf8'),
  ) as { titles: string[] }
).titles;

const RESUME = `
Himani Prasad — Backend Engineer, Bengaluru

Four years building distributed backend services. Go, Python, Postgres,
Kafka, Redis. Designed and shipped a payments ledger handling settlement and
reconciliation for a lending product. Owned the API platform: REST and gRPC
services, schema migrations, idempotency, retries.

Infrastructure: Kubernetes, Docker, Terraform, AWS. Built the CI pipeline and
the observability stack (Prometheus, Grafana, distributed tracing).

Previously: fraud detection service in Python, feature pipelines, and a
banking integration with a core banking provider.
`;

function contextFor(resumeText: string | null, signals: [string, number][] = []): ScoringContext {
  return {
    signals: new Map(signals),
    vocabulary: profileVocabulary({ resumeText }),
  };
}

const backend = contextFor(RESUME);

const scoreOf = (title: string, ctx = backend) => scoreLexically({ title }, ctx).score;

describe('ranking a real board against a real resume', () => {
  const ranked = [...titles]
    .map((title) => ({ title, score: scoreOf(title) }))
    .sort((a, b) => b.score - a.score);

  it('does not park everything at the neutral midpoint', () => {
    // The bug this whole module was rewritten for.
    const distinct = new Set(ranked.map((r) => Math.round(r.score)));
    expect(distinct.size).toBeGreaterThan(6);
    expect(ranked[0]!.score - ranked[ranked.length - 1]!.score).toBeGreaterThan(30);
  });

  it('puts engineering roles above marketing, sales, design and legal ones', () => {
    const engineering = ranked.filter((r) => /Engineer|Infrastructure|Platform/i.test(r.title));
    const notForThem = ranked.filter((r) =>
      /Marketer|Sales|Counsel|Designer|Auditor|Producer|Recruit|HRIS|Events/i.test(r.title),
    );

    const mean = (xs: { score: number }[]) => xs.reduce((a, b) => a + b.score, 0) / xs.length;
    expect(mean(engineering)).toBeGreaterThan(mean(notForThem) + 15);

    // And the top of the list is dominated by jobs they could actually do.
    const topTen = ranked.slice(0, 10).map((r) => r.title);
    const engineeringInTopTen = topTen.filter((t) => /Engineer|Infrastructure|Platform/i.test(t));
    expect(engineeringInTopTen.length).toBeGreaterThanOrEqual(6);
  });

  it('ranks the obvious pairs the obvious way', () => {
    const pairs: [string, string][] = [
      ['Senior Backend Engineer - Product', 'Content Marketer'],
      ['Senior Backend Engineer - Product', 'Sales Development Representative'],
      ['Software Engineer - Infrastructure', 'Staff Visual Designer - Design Systems'],
      ['Senior Software Engineer - Banking Integration Platform', 'Senior Internal Auditor - Finance'],
      ['Senior Software Engineer - Fraud', 'Executive Producer - Brand Creative'],
    ];
    for (const [better, worse] of pairs) {
      expect(`${better}: ${scoreOf(better).toFixed(0)}`).not.toBe(
        `${worse}: ${scoreOf(worse).toFixed(0)}`,
      );
      expect(scoreOf(better)).toBeGreaterThan(scoreOf(worse));
    }
  });

  it('does not let a one-word title swing the whole score', () => {
    // "Software Engineer - Infrastructure" has exactly one term the stoplist
    // does not eat. Unsmoothed, matching it scores 99 and missing it scores 8,
    // which is a coin flip dressed up as a ranking.
    const matched = scoreOf('Software Engineer - Infrastructure');
    const missed = scoreOf('Software Engineer - Choreography');
    expect(matched).toBeLessThan(85);
    expect(missed).toBeGreaterThan(15);
    expect(matched).toBeGreaterThan(missed);
  });
});

describe('what the score is made of', () => {
  it('says which of the posting’s words the candidate has and which they do not', () => {
    const lex = scoreLexically(
      {
        title: 'Senior Backend Engineer - Payments',
        descriptionText:
          'Own the settlement ledger. Go, Postgres and Kafka. Kubernetes in production. ' +
          'You will also run our Salesforce integration and the Salesforce data model.',
      },
      backend,
    );
    expect(lex.shared).toContain('backend');
    expect(lex.shared).toContain('payments');
    expect(lex.missing).toContain('salesforce');
    expect(lex.affinity).toBeGreaterThan(0.35);
  });

  it('still holds no opinion when there is no resume to hold one with', () => {
    const empty = contextFor(null);
    const lex = scoreLexically({ title: 'Senior Backend Engineer - Product' }, empty);
    expect(lex.score).toBeCloseTo(50, 5);
    expect(lex.confidence).toBe(0);
  });

  it('regains an opinion from decisions alone, with no resume', () => {
    const learned = contextFor(null, [['payments', 2.5]]);
    const lex = scoreLexically({ title: 'Backend Engineer, Payments' }, learned);
    expect(lex.score).toBeGreaterThan(60);
    expect(lex.confidence).toBeGreaterThan(0);
    expect(lex.confidence).toBeLessThan(0.5);
  });
});

describe('blending the cheap pass with a model read', () => {
  const fit = (score: number, dealbreaker = ''): FitAssessment => ({
    score,
    verdict: 'WORTH_A_LOOK',
    forIt: [],
    againstIt: [],
    seniorityFit: 'MATCH',
    dealbreaker,
  });

  it('ignores the cheap pass entirely when it knows nothing', () => {
    // It used to take a flat 30% of every blend even while scoring everything
    // at 50, which dragged a model's 90 down to 78 and pushed its 20 up to 29.
    const opinionless = scoreLexically({ title: 'Anything At All' }, contextFor(null));
    expect(blendScores(fit(90), opinionless)).toBeCloseTo(90, 5);
    expect(blendScores(fit(20), opinionless)).toBeCloseTo(20, 5);
  });

  it('lets it vote once it has a resume behind it', () => {
    const lex = scoreLexically({ title: 'Content Marketer' }, backend);
    const blended = blendScores(fit(90), lex);
    expect(blended).toBeLessThan(90);
    // But never enough to overturn the model: it is a prior, not a verdict.
    expect(blended).toBeGreaterThan(70);
  });

  it('a hard blocker still caps the score, whatever the words say', () => {
    const lex = scoreLexically({ title: 'Senior Backend Engineer - Payments' }, backend);
    expect(blendScores(fit(88, 'Requires US clearance'), lex)).toBeLessThanOrEqual(15);
  });
});
