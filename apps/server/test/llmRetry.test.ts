import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * A free tier's per-minute cap is a normal condition, not a failure.
 *
 * A live run lost its cover letter to "Gemini rate limit or quota exhausted"
 * seconds before the window would have reopened. Both providers were already
 * marking that error retryable; nothing was acting on it.
 */

let calls = 0;
let behaviour: () => unknown = () => null;

// Mocked at the class, not at `provider()`: generate() resolves that through a
// module-local binding, so spying on the export would not intercept it.
vi.mock('../src/llm/geminiProvider.js', () => ({
  GeminiProvider: class {
    id = 'gemini' as const;
    modelFor() {
      return 'test-model';
    }
    async generate() {
      calls++;
      return behaviour();
    }
    async listModels() {
      return [];
    }
    describeError(e: unknown) {
      return String(e);
    }
  },
}));

process.env.GEMINI_API_KEY = 'test-key-for-retries';
delete process.env.LLM_PROVIDER;
// Same number of attempts, none of the waiting. The schedule is what is under
// test everywhere else; here it is the retry *policy*.
process.env.LLM_RETRY_DELAYS_MS = '1,1,1';

const { generate, resetProvider, LlmUnavailableError } = await import('../src/llm/client.js');

const Schema = z.object({ ok: z.boolean() });
const args = {
  task: 'fitScoring' as const,
  system: 's',
  prompt: 'p',
  schema: Schema,
  maxTokens: 10,
};

beforeEach(() => {
  calls = 0;
  resetProvider();
});

afterEach(() => {
  resetProvider();
});

describe('retrying a rate limit', () => {
  it('waits and succeeds, rather than losing the work', async () => {
    behaviour = () => {
      if (calls === 1) throw new LlmUnavailableError('rate limited', true);
      return { ok: true };
    };
    await expect(generate(args)).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  }, 60_000);

  it('gives up rather than hanging on a cap that will not clear', async () => {
    behaviour = () => {
      throw new LlmUnavailableError('quota exhausted for the day', true);
    };
    await expect(generate(args)).rejects.toThrow(/quota exhausted/);
    // Three delays, so four attempts in total.
    expect(calls).toBe(4);
  }, 60_000);
});

describe('what must never be retried', () => {
  it('does not retry a rejected key, which will not improve with waiting', async () => {
    behaviour = () => {
      throw new LlmUnavailableError('API key rejected', false);
    };
    await expect(generate(args)).rejects.toThrow(/key rejected/);
    expect(calls).toBe(1);
  }, 60_000);

  it('does not retry a refusal', async () => {
    // null means "ask the human". Asking again is pointless, and is a way to
    // talk a model out of a refusal it was right to make.
    behaviour = () => null;
    await expect(generate(args)).resolves.toBeNull();
    expect(calls).toBe(1);
  }, 60_000);

  it('does not retry an ordinary error', async () => {
    behaviour = () => {
      throw new Error('something else went wrong');
    };
    await expect(generate(args)).rejects.toThrow(/something else/);
    expect(calls).toBe(1);
  }, 60_000);
});
