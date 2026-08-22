import Anthropic from '@anthropic-ai/sdk';
import { config, assertLlmConfigured } from '../lib/config.js';

let cached: Anthropic | null = null;

export function llm(): Anthropic {
  assertLlmConfigured();
  cached ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return cached;
}

export const MODEL = config.anthropicModel;

/** Turn SDK errors into something a run log can show a human. */
export function describeLlmError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic API key rejected.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit hit; back off and retry.';
  if (err instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
