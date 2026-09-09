import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { LlmUnavailableError } from '../src/llm/client.js';
import { ZodError } from 'zod';
import { z } from 'zod';

describe('global error handler', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    // Set up the same error handler as the main app
    app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
      // Handle Zod validation errors
      if (err instanceof ZodError) {
        return reply.code(400).send({
          error: 'Invalid request',
          issues: (err as any).issues,
        });
      }

      if (err instanceof LlmUnavailableError) {
        // Rate limit errors should return 429
        if (err.retryable && /rate limit|quota exhausted|429/i.test(err.message)) {
          return reply.code(429).send({ error: err.message });
        }
        // Other LLM unavailability errors return 400
        return reply.code(400).send({ error: err.message });
      }

      // Log unexpected errors and return 500
      req.log.error(err);
      return reply.code(500).send({ error: 'Internal server error' });
    });

    // Add a test route that throws LlmUnavailableError
    app.get('/test/rate-limit', async () => {
      throw new LlmUnavailableError(
        'Gemini rate limit or quota exhausted. The free tier has per-minute and per-day caps; wait, or enable billing on the project.',
        true,
      );
    });

    app.get('/test/bad-key', async () => {
      throw new LlmUnavailableError('Gemini rejected the API key. Check GEMINI_API_KEY.', false);
    });

    app.get('/test/other-error', async () => {
      throw new Error('Some other error');
    });

    app.get('/test/zod-error', async () => {
      const schema = z.object({
        field: z.string(),
      });
      schema.parse({ field: 123 }); // This will throw ZodError
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 for rate limit errors', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/rate-limit',
    });

    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('rate limit');
  });

  it('returns 400 for non-retryable LLM errors', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/bad-key',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('API key');
  });

  it('returns 500 for unexpected errors', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/other-error',
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe('Internal server error');
  });

  it('returns 400 for Zod validation errors', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/zod-error',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe('Invalid request');
    expect(body.issues).toBeDefined();
    expect(body.issues.length).toBeGreaterThan(0);
  });
});
