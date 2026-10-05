import type { z } from 'zod';
import type { Task } from './models.js';

/**
 * The one thing this app asks of a model: given a system prompt and a user
 * prompt, return an object matching a Zod schema, or null.
 *
 * Everything upstream — answer inference, fit scoring, keyword analysis,
 * cover letters — is structured output. Nothing streams, nothing uses tools,
 * nothing needs multi-turn. So the provider seam is deliberately one method
 * wide: anything that can be made to emit schema-conforming JSON can be
 * plugged in behind it.
 *
 * `null` is a first-class result, not an error. A model that declines, returns
 * unparseable JSON, or emits something that fails schema validation is treated
 * the same way as one that says "I cannot answer this" — the caller falls back
 * to asking the human. That property is what lets the no-fabrication
 * guarantees survive a provider swap.
 */
export interface GenerateArgs<T> {
  /** Selects the model and effort tier. */
  task: Task;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}

export interface LlmProvider {
  id: 'anthropic' | 'gemini';
  /** The model this task will actually run on, for logging and cost display. */
  modelFor(task: Task): string;
  generate<T>(args: GenerateArgs<T>): Promise<T | null>;
  /** Model ids this API key can actually reach. Empty if the provider cannot say. */
  listModels(): Promise<string[]>;
  describeError(err: unknown): string;
}

/**
 * Providers differ in how they surface a refusal, a truncation or a bad key,
 * and the callers should not have to care. This is thrown only for conditions
 * the caller genuinely cannot proceed through — a missing key, a rejected key,
 * a rate limit. Anything softer comes back as `null`.
 */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}
