import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../lib/config.js';
import { effortFor, modelFor, type Task } from './models.js';
import { LlmUnavailableError, type GenerateArgs, type LlmProvider } from './provider.js';

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private client: Anthropic | null = null;

  private sdk(): Anthropic {
    if (!config.anthropicApiKey) {
      throw new LlmUnavailableError(
        'ANTHROPIC_API_KEY is not set. Get one at https://console.anthropic.com, or switch to Gemini with LLM_PROVIDER=gemini.',
        false,
      );
    }
    this.client ??= new Anthropic({ apiKey: config.anthropicApiKey });
    return this.client;
  }

  modelFor(task: Task): string {
    return modelFor(task);
  }

  async generate<T>(args: GenerateArgs<T>): Promise<T | null> {
    try {
      const res = await this.sdk().messages.parse({
        model: this.modelFor(args.task),
        max_tokens: args.maxTokens,
        system: args.system,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: effortFor(args.task),
          format: zodOutputFormat(args.schema),
        },
        messages: [{ role: 'user', content: args.prompt }],
      });
      // A refusal is a legitimate outcome, not a crash: the caller falls back
      // to asking the human, same as any other null.
      if (res.stop_reason === 'refusal') return null;
      return (res.parsed_output as T | null) ?? null;
    } catch (err) {
      throw new LlmUnavailableError(this.describeError(err), isRetryable(err));
    }
  }

  /** The Models API reports what this key can reach. */
  async listModels(): Promise<string[]> {
    if (!config.anthropicApiKey) return [];
    try {
      const out: string[] = [];
      for await (const m of this.sdk().models.list()) out.push(m.id);
      return out.sort();
    } catch {
      return [];
    }
  }

  describeError(err: unknown): string {
    if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key.';
    if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit hit; back off and retry.';
    if (err instanceof Anthropic.NotFoundError) {
      return 'Anthropic does not recognise that model id. Check ANTHROPIC_MODEL against GET /api/models.';
    }
    if (err instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${err.message}`;
    if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
    return err instanceof Error ? err.message : String(err);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) return (err.status ?? 0) >= 500;
  return false;
}
