import { describe, expect, it } from 'vitest';
import { modelFor, effortFor, estimateCost, estimateActivityCosts } from '../src/llm/models.js';
import { config } from '../src/lib/config.js';

/**
 * The model split is a cost decision with a correctness edge: the two tasks
 * that must never be downgraded are the ones that decide what goes on your
 * resume and what gets written in your name.
 */
describe('model routing', () => {
  it('puts the high-volume judgement calls on the cheaper model', () => {
    expect(modelFor('answerInference')).toBe(config.cheapModel);
    expect(modelFor('fitScoring')).toBe(config.cheapModel);
  });

  it('keeps everything that produces text you submit on the strong model', () => {
    for (const task of ['coverLetter', 'essay', 'resumeRewrite'] as const) {
      expect(modelFor(task), task).toBe(config.anthropicModel);
    }
  });

  it('keeps the grounded/unsupported decision on the strong model', () => {
    // This is the step that decides whether a claim can go on a resume.
    // Downgrading it to save a cent is exactly the wrong trade.
    expect(modelFor('keywordAnalysis')).toBe(config.anthropicModel);
  });

  it('spends less effort on the calls that run most often', () => {
    expect(effortFor('answerInference')).toBe('low');
    expect(effortFor('fitScoring')).toBe('low');
    expect(effortFor('coverLetter')).toBe('high');
    expect(effortFor('keywordAnalysis')).toBe('high');
  });
});

describe('cost estimation', () => {
  it('prices a known model from its published rates', () => {
    // 1M input + 1M output on Opus 5 at $5/$25.
    expect(estimateCost('claude-opus-5', 1_000_000, 1_000_000)).toBeCloseTo(30, 5);
    expect(estimateCost('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(6, 5);
  });

  it('falls back to the top-tier rate for an unknown model, so estimates never flatter', () => {
    expect(estimateCost('some-future-model', 1_000_000, 0)).toBe(
      estimateCost('claude-opus-5', 1_000_000, 0),
    );
  });

  it('produces per-activity figures in a sane range', () => {
    const c = estimateActivityCosts();
    for (const [k, v] of Object.entries(c)) {
      expect(v, k).toBeGreaterThan(0);
      expect(v, k).toBeLessThan(2);
    }
    // Tailoring reads and rewrites a whole resume twice; it is the priciest.
    expect(c.perTailoring).toBeGreaterThan(c.perDeepScoredLead);
  });
});
