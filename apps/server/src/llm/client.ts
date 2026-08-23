import { config } from '../lib/config.js';
import { AnthropicProvider } from './anthropicProvider.js';
import { GeminiProvider } from './geminiProvider.js';
import { LlmUnavailableError, type GenerateArgs, type LlmProvider } from './provider.js';

let cached: LlmProvider | null = null;

/**
 * Pick the backend.
 *
 * Explicit LLM_PROVIDER wins. Otherwise it is inferred from whichever key is
 * present, which keeps the common case to one line of .env: paste a key and
 * go. Gemini is preferred when both are set, on the grounds that someone who
 * configured a free key probably meant to use it.
 */
export function provider(): LlmProvider {
  if (cached) return cached;

  const explicit = config.llmProvider;
  const chosen =
    explicit ?? (config.geminiApiKey ? 'gemini' : config.anthropicApiKey ? 'anthropic' : null);

  if (!chosen) {
    throw new LlmUnavailableError(
      'No model provider configured. Set GEMINI_API_KEY (free tier at https://aistudio.google.com/apikey) ' +
        'or ANTHROPIC_API_KEY, and optionally LLM_PROVIDER to pick between them.',
      false,
    );
  }

  cached = chosen === 'gemini' ? new GeminiProvider() : new AnthropicProvider();
  return cached;
}

/** Reset the memoised provider. Used by tests and after a config change. */
export function resetProvider(): void {
  cached = null;
}

/** True when a key is present, without constructing anything. */
export function isConfigured(): boolean {
  const chosen = config.llmProvider ?? (config.geminiApiKey ? 'gemini' : 'anthropic');
  return chosen === 'gemini' ? Boolean(config.geminiApiKey) : Boolean(config.anthropicApiKey);
}

/**
 * The single entry point every feature uses to talk to a model.
 *
 * With one retry policy for the whole app, because a free tier's per-minute
 * cap is a normal condition rather than a failure. A live run lost its cover
 * letter to "Gemini rate limit or quota exhausted" a few seconds before the
 * quota would have freed up again; both providers were already classifying
 * that error as retryable and nothing was acting on it.
 *
 * Three things are deliberately *not* retried:
 *
 *  - `null`. The model declining is a first-class answer meaning "ask the
 *    human", and asking again is both pointless and a way to talk a model out
 *    of a refusal it was right to make.
 *  - Anything the provider marked non-retryable: a rejected key, an unknown
 *    model id, a safety block. Those do not improve with waiting.
 *  - A daily cap, in effect. It will exhaust the attempts and fail, which is
 *    correct - the error text already explains the difference - but it costs
 *    only twenty seconds to find out.
 */
export async function generate<T>(args: GenerateArgs<T>): Promise<T | null> {
  let lastError: unknown;

  const delays = config.llmRetryDelaysMs;
  for (let attempt = 0; attempt < delays.length + 1; attempt++) {
    try {
      return await provider().generate(args);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof LlmUnavailableError && err.retryable;
      const delay = delays[attempt];
      if (!retryable || delay === undefined) break;

      // Jitter, so a burst of calls does not come back in lockstep and
      // reproduce the same spike that caused the limit.
      const wait = delay + Math.floor(Math.random() * 400);
      process.stdout.write(
        `[llm] ${args.task}: ${describeLlmError(err)} Retrying in ${Math.round(wait / 1000)}s.\n`,
      );
      await sleep(wait);
    }
  }
  throw lastError;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function describeLlmError(err: unknown): string {
  if (err instanceof LlmUnavailableError) return err.message;
  try {
    return provider().describeError(err);
  } catch {
    return err instanceof Error ? err.message : String(err);
  }
}

export { LlmUnavailableError };
