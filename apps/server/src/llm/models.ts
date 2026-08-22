import { activeProvider, config } from '../lib/config.js';

/**
 * Which model runs which task.
 *
 * The work here splits cleanly into two kinds, and paying Opus rates for both
 * is simply waste:
 *
 *  - **Judgement calls on short, structured inputs.** Deciding whether a form
 *    question is answerable from a resume, or whether a posting fits. These are
 *    closer to classification than to writing; a smaller model does them well
 *    and they run many times per application.
 *  - **Writing that goes out under your name.** Cover letters, essay answers,
 *    and the resume rewrite. These run once or twice, and the quality gap is
 *    the whole point of the feature.
 *
 * Defaults put the second group on the strongest model and the first on Haiku,
 * which is roughly a fifth of the cost. Every slot is overridable, so
 * `ANTHROPIC_MODEL_CHEAP=claude-opus-5` puts everything back on one model if
 * you would rather not think about it.
 */
export type Task =
  /** Can this form question be answered from what we know? */
  | 'answerInference'
  /** Does this posting fit this candidate? */
  | 'fitScoring'
  /** Turn a profile into the web searches that would surface its jobs. */
  | 'searchPlanning'
  /** Sort a job's keywords into covered / grounded / unsupported. */
  | 'keywordAnalysis'
  /** Rewrite the resume within the allow-list. */
  | 'resumeRewrite'
  /** Write a cover letter. */
  | 'coverLetter'
  /** Answer one short employer-specific question. */
  | 'essay';

const CHEAP: Task[] = ['answerInference', 'fitScoring', 'searchPlanning'];

/**
 * Keyword analysis sits on the expensive model deliberately. It is the step
 * that decides whether a claim is grounded, and getting that wrong is how an
 * unsupported skill ends up on a resume with your name on it. Not the place to
 * save a cent.
 */
export function modelFor(task: Task): string {
  const cheap = CHEAP.includes(task);
  return activeProvider() === 'gemini'
    ? cheap
      ? config.geminiModelCheap
      : config.geminiModel
    : cheap
      ? config.anthropicModelCheap
      : config.anthropicModel;
}

/** The two slots in use, for display. */
export function activeModels(): { writing: string; judgement: string; provider: string } {
  return {
    provider: activeProvider(),
    writing: modelFor('coverLetter'),
    judgement: modelFor('answerInference'),
  };
}

/**
 * Effort per task. Lower effort on the high-volume calls is the other half of
 * the cost story, and it matters more than the model choice on short inputs.
 */
export function effortFor(task: Task): 'low' | 'medium' | 'high' {
  switch (task) {
    case 'answerInference':
      return 'low';
    case 'fitScoring':
      return 'low';
    case 'searchPlanning':
      return 'medium';
    case 'essay':
      return 'medium';
    default:
      return 'high';
  }
}

/**
 * Published per-million-token rates, used only for the local cost estimate the
 * UI shows. Wrong numbers here cost nothing but a misleading estimate, and the
 * real figure is always on your Anthropic console.
 */
const RATES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
};

/**
 * Gemini's free tier bills nothing, so a spend estimate for it would be
 * theatre. What actually constrains a free key is requests per minute and per
 * day, which is a different unit and is reported separately.
 */
const FREE_TIER_MODELS = /^gemini-.*(flash|lite)/i;

export function isFreeTier(model: string): boolean {
  return activeProvider() === 'gemini' && FREE_TIER_MODELS.test(model);
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  if (isFreeTier(model)) return 0;
  const rate = RATES[model];
  if (rate) {
    return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
  }
  // Unknown model: fall back to the most expensive rate we know, so an
  // estimate is never rosier than reality.
  const top = RATES['claude-fable-5']!;
  return (inputTokens / 1_000_000) * top.input + (outputTokens / 1_000_000) * top.output;
}

/** Rough per-activity cost, for the settings page. */
export function estimateActivityCosts(): {
  perApplication: number;
  perTailoring: number;
  perDeepScoredLead: number;
  free: boolean;
} {
  const { writing: good, judgement: cheap } = activeModels();
  return {
    // ~4 inferred fields, plus a cover letter and one essay.
    perApplication:
      4 * estimateCost(cheap, 2200, 500) +
      estimateCost(good, 6000, 1200) +
      estimateCost(good, 4500, 400),
    // Analysis then rewrite, both on long inputs.
    perTailoring: estimateCost(good, 11000, 2500) + estimateCost(good, 12000, 4000),
    perDeepScoredLead: estimateCost(cheap, 8000, 900),
    free: isFreeTier(good) && isFreeTier(cheap),
  };
}
