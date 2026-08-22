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

/** The single entry point every feature uses to talk to a model. */
export function generate<T>(args: GenerateArgs<T>): Promise<T | null> {
  return provider().generate(args);
}

export function describeLlmError(err: unknown): string {
  if (err instanceof LlmUnavailableError) return err.message;
  try {
    return provider().describeError(err);
  } catch {
    return err instanceof Error ? err.message : String(err);
  }
}

export { LlmUnavailableError };
