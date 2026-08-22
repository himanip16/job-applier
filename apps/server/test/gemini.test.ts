import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * The Gemini backend.
 *
 * The interesting cases are all failure cases. Constrained decoding gives you
 * a shape guarantee and nothing more, so what matters is that every way a
 * model can misbehave — truncated JSON, a markdown fence, schema-valid
 * nonsense, an exhausted quota — comes out the far side as either a clean
 * `null` or a clearly-worded error, never as data the resolver will act on.
 */

process.env.LLM_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-key';

const generateContent = vi.fn();
vi.mock('@google/genai', async () => {
  const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent };
    },
  };
});

const { GeminiProvider, toGeminiSchema } = await import('../src/llm/geminiProvider.js');
const { LlmUnavailableError } = await import('../src/llm/provider.js');
const { activeModels, isFreeTier, estimateActivityCosts } = await import('../src/llm/models.js');

const Schema = z.object({
  answerable: z.boolean(),
  value: z.string(),
  confidence: z.number(),
});

const args = {
  task: 'answerInference' as const,
  system: 'be honest',
  prompt: 'what is the notice period?',
  schema: Schema,
  maxTokens: 500,
};

let provider: InstanceType<typeof GeminiProvider>;
beforeEach(() => {
  generateContent.mockReset();
  provider = new GeminiProvider();
});
afterEach(() => vi.clearAllMocks());

describe('schema translation', () => {
  it('strips the keywords Gemini rejects but keeps the descriptions', () => {
    const s = z.object({
      value: z.string().describe('copied exactly from the options'),
      nested: z.object({ n: z.number() }),
      list: z.array(z.string()),
    });
    const out = toGeminiSchema(s);

    expect(out).not.toHaveProperty('$schema');
    expect(out).not.toHaveProperty('additionalProperties');
    const props = out.properties as Record<string, Record<string, unknown>>;
    // Nested objects are scrubbed too, not just the root.
    expect(props.nested).not.toHaveProperty('additionalProperties');
    // The describe() text does real instructional work; losing it would
    // degrade output quality silently rather than fail loudly.
    expect(props.value!.description).toBe('copied exactly from the options');
    expect(out.type).toBe('object');
    expect(out.required).toEqual(['value', 'nested', 'list']);
  });

  it('translates every real schema in the app without throwing', async () => {
    // A schema that survives translation here is one the provider can actually
    // send; a regression in Zod output would otherwise only show up at runtime.
    const enumSchema = z.object({
      verdict: z.enum(['STRONG', 'MISMATCH']),
      items: z.array(z.object({ keyword: z.string(), importance: z.enum(['REQUIRED', 'PREFERRED']) })),
    });
    const out = toGeminiSchema(enumSchema);
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.verdict!.enum).toEqual(['STRONG', 'MISMATCH']);
    expect(JSON.stringify(out)).not.toContain('$schema');
  });
});

describe('reading a response', () => {
  it('parses a well-formed answer', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({ answerable: true, value: '1 month', confidence: 0.9 }),
    });
    await expect(provider.generate(args)).resolves.toEqual({
      answerable: true,
      value: '1 month',
      confidence: 0.9,
    });
  });

  it('unwraps a markdown fence, which Gemini emits despite the JSON mime type', async () => {
    generateContent.mockResolvedValue({
      text: '```json\n{"answerable": false, "value": "", "confidence": 0}\n```',
    });
    await expect(provider.generate(args)).resolves.toMatchObject({ answerable: false });
  });

  it('returns null on truncated JSON rather than throwing', async () => {
    // Hitting maxOutputTokens mid-object. The caller must fall back to asking
    // the human, not crash the run.
    generateContent.mockResolvedValue({ text: '{"answerable": true, "value": "1 mon' });
    await expect(provider.generate(args)).resolves.toBeNull();
  });

  it('returns null when the JSON parses but does not match the schema', async () => {
    // This is the case constrained decoding is supposed to prevent and
    // occasionally does not. Validating again is what stops a malformed
    // answerable:true reaching the resolver.
    generateContent.mockResolvedValue({ text: '{"answerable": "yes please", "value": 42}' });
    await expect(provider.generate(args)).resolves.toBeNull();
  });

  it('returns null on an empty response', async () => {
    generateContent.mockResolvedValue({ text: '' });
    await expect(provider.generate(args)).resolves.toBeNull();
  });
});

describe('errors', () => {
  it('explains a bad key without leaking it', async () => {
    generateContent.mockRejectedValue(new Error('API key not valid. Please pass a valid API key.'));
    await expect(provider.generate(args)).rejects.toThrow(/rejected the API key/i);
    await expect(provider.generate(args)).rejects.not.toThrow(/test-key/);
  });

  it('explains an exhausted free-tier quota, and marks it retryable', async () => {
    generateContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED: quota exceeded'));
    const err = await provider.generate(args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as InstanceType<typeof LlmUnavailableError>).retryable).toBe(true);
    expect((err as Error).message).toMatch(/free tier has per-minute and per-day caps/i);
  });

  it('points at the model config when the id is wrong, since ids move', async () => {
    generateContent.mockRejectedValue(new Error('404 NOT_FOUND: models/gemini-old is not found'));
    await expect(provider.generate(args)).rejects.toThrow(/GEMINI_MODEL/);
  });

  it('does not mark a bad key retryable — retrying will never fix it', async () => {
    generateContent.mockRejectedValue(new Error('API_KEY_INVALID'));
    const err = await provider.generate(args).catch((e: unknown) => e);
    expect((err as InstanceType<typeof LlmUnavailableError>).retryable).toBe(false);
  });
});

describe('cost reporting under Gemini', () => {
  it('reports free-tier models as free rather than inventing a price', () => {
    expect(isFreeTier('gemini-3.5-flash')).toBe(true);
    expect(isFreeTier('gemini-3.1-flash-lite')).toBe(true);
  });

  it('flags the whole setup as free when both slots are free-tier', () => {
    const { writing, judgement } = activeModels();
    const costs = estimateActivityCosts();
    if (isFreeTier(writing) && isFreeTier(judgement)) {
      expect(costs.free).toBe(true);
      expect(costs.perApplication).toBe(0);
    }
  });
});
