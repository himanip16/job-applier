import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { effortFor, modelFor, type Task } from './models.js';
import { LlmUnavailableError, type GenerateArgs, type LlmProvider } from './provider.js';

/**
 * Gemini backend.
 *
 * Two things are worth knowing about how this differs from the Anthropic path.
 *
 * First, structured output. Gemini takes a JSON Schema on `responseJsonSchema`
 * and constrains decoding to it, which is the same idea as Anthropic's
 * `output_config.format`. But the guarantee is about *shape*, not semantics:
 * the model can still return a schema-valid object whose contents are wrong.
 * So the response is parsed and then validated against the Zod schema anyway.
 * That second check is not belt-and-braces here — it is what stops a malformed
 * `answerable: true` from being taken at face value by the resolver.
 *
 * Second, the schema dialect. Gemini accepts an OpenAPI-flavoured subset and
 * rejects several keywords that Zod's JSON Schema output includes by default,
 * so the schema is scrubbed before it is sent.
 */
export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const;
  private client: GoogleGenAI | null = null;

  private sdk(): GoogleGenAI {
    if (!config.geminiApiKey) {
      throw new LlmUnavailableError(
        'GEMINI_API_KEY is not set. Get one free at https://aistudio.google.com/apikey and put it in .env.',
        false,
      );
    }
    this.client ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
    return this.client;
  }

  modelFor(task: Task): string {
    return modelFor(task);
  }

  async generate<T>(args: GenerateArgs<T>): Promise<T | null> {
    const model = this.modelFor(args.task);
    let raw: string | undefined;

    try {
      const res = await this.sdk().models.generateContent({
        model,
        contents: args.prompt,
        config: {
          systemInstruction: args.system,
          maxOutputTokens: args.maxTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: toGeminiSchema(args.schema),
          thinkingConfig: { thinkingLevel: thinkingLevelFor(args.task) },
          // These prompts ask the model to reason about a real person's
          // employment history and to decline when it cannot. Determinism
          // matters more than variety in every one of them.
          temperature: 0.2,
        },
      });
      raw = res.text;
    } catch (err) {
      throw new LlmUnavailableError(this.describeError(err), isRetryable(err));
    }

    if (!raw?.trim()) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch {
      // Constrained decoding makes this rare, but a truncated response (hitting
      // maxOutputTokens mid-object) lands here. Null is the honest answer.
      return null;
    }

    const result = args.schema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  /**
   * Ask the key what it can reach.
   *
   * Model ids move — the Gemini line has renamed and deprecated several within
   * a year — so the app should not hard-code a list it will be wrong about.
   * The SDK has no list method, so this is the raw REST endpoint.
   */
  async listModels(): Promise<string[]> {
    if (!config.geminiApiKey) return [];
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        { headers: { 'x-goog-api-key': config.geminiApiKey } },
      );
      if (!res.ok) return [];
      const body = (await res.json()) as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
      };
      return (body.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => (m.name ?? '').replace(/^models\//, ''))
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  }

  describeError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/API[_ ]key not valid|API_KEY_INVALID|401/i.test(msg)) {
      return 'Gemini rejected the API key. Check GEMINI_API_KEY.';
    }
    if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
      return 'Gemini rate limit or quota exhausted. The free tier has per-minute and per-day caps; wait, or enable billing on the project.';
    }
    if (/not found|NOT_FOUND|404/i.test(msg)) {
      return `Gemini does not recognise that model id. Check GEMINI_MODEL / GEMINI_MODEL_CHEAP against GET /api/models.`;
    }
    if (/SAFETY|blocked/i.test(msg)) {
      return 'Gemini blocked the response on safety grounds.';
    }
    return `Gemini error: ${msg}`;
  }
}

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /RESOURCE_EXHAUSTED|429|50\d|UNAVAILABLE|deadline/i.test(msg);
}

/** Gemini sometimes wraps JSON in a markdown fence despite the mime type. */
function stripCodeFence(s: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(s);
  return fenced ? fenced[1]! : s;
}

function thinkingLevelFor(task: Task): ThinkingLevel {
  switch (effortFor(task)) {
    case 'low':
      return ThinkingLevel.LOW;
    case 'medium':
      return ThinkingLevel.MEDIUM;
    default:
      return ThinkingLevel.HIGH;
  }
}

/**
 * Zod's JSON Schema output carries keywords Gemini's OpenAPI-flavoured subset
 * rejects outright. Sending them back is a 400, not a warning, so they are
 * stripped recursively.
 *
 * `description` is deliberately kept: every field in these schemas carries a
 * `.describe()` that is doing real instructional work — "copied exactly",
 * "empty when answerable is false" — and losing it would quietly degrade
 * output quality rather than fail loudly.
 */
export function toGeminiSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  return scrub(z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>);
}

const DROP = new Set([
  '$schema',
  '$id',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'const',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
]);

function scrub(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) return node.map(scrub) as unknown as Record<string, unknown>;
  if (node === null || typeof node !== 'object') return node as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (DROP.has(key)) continue;
    out[key] = typeof value === 'object' && value !== null ? scrub(value) : value;
  }
  return out;
}
