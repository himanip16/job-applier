import { describe, expect, it } from 'vitest';

/**
 * The failure this guards against, reproduced.
 *
 * A real install hit `TypeError: Cannot read properties of undefined (reading
 * 'count')` on every dashboard poll, because the generated Prisma client
 * predated the Company model. `generated/` is gitignored, so pulling the
 * branch that added it left the client stale. The message named neither the
 * model nor the fix.
 */

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { checkGeneratedClient, checkTablesExist, schemaProblem } = await import(
  '../src/lib/schemaCheck.js'
);

describe('detecting a stale generated client', () => {
  it('passes when the client matches the schema', async () => {
    const result = await checkGeneratedClient();
    expect(result.ok, result.message).toBe(true);
    expect(result.missingModels).toEqual([]);
  });

  it('names the missing model and the command to run', async () => {
    // Exactly the state the real install was in: Company exists in
    // schema.prisma but the client has no accessor for it.
    const stale = withoutModels('company');

    const result = await checkGeneratedClient(stale);
    expect(result.ok).toBe(false);
    expect(result.missingModels).toContain('Company');
    // The message has to carry the fix, not just the symptom.
    expect(result.message).toMatch(/pnpm db:push/);
    expect(result.message).toMatch(/out of date/i);
    expect(result.message).toMatch(/Company/);
    // And explain why it happened, since "regenerate" alone leaves you
    // wondering whether it will happen again.
    expect(result.message).toMatch(/generated\/ is not committed/);
  });

  it('checks every model in the schema, not a hardcoded list', async () => {
    // A model added later must be covered without anyone updating the check.
    const stale = withoutModels('interviewRound', 'lesson');

    const result = await checkGeneratedClient(stale);
    expect(result.missingModels).toEqual(expect.arrayContaining(['InterviewRound', 'Lesson']));
    // ...and does not cry wolf about the ones that are present.
    expect(result.missingModels).not.toContain('Profile');
  });
});

/** A snapshot of the real client with some model accessors removed. */
function withoutModels(...accessors: string[]): Record<string, unknown> {
  const real = prisma as unknown as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  // Copy through the getters rather than spreading, which the Prisma client's
  // property descriptors do not survive.
  for (const key of Object.keys(real)) copy[key] = real[key];
  for (const key of [
    'profile', 'profileFact', 'resumeFile', 'answer', 'job', 'application',
    'pendingQuestion', 'applicationEvent', 'artifact', 'company', 'jobLead',
    'preferenceSignal', 'tailoredResume', 'interviewRound', 'interviewQuestion', 'lesson',
  ]) {
    copy[key] = real[key] ?? {};
  }
  for (const key of accessors) delete copy[key];
  return copy;
}

describe('detecting missing tables', () => {
  it('passes against a pushed schema', async () => {
    const result = await checkTablesExist();
    expect(result.ok, result.message).toBe(true);
  });

  it('tells you to push rather than echoing a Prisma error code', async () => {
    const result = await withFailingCount(
      new Error('The table `public.companies` does not exist in the current database.'),
      checkTablesExist,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/pnpm db:push/);
  });

  it('passes a connection failure through verbatim rather than guessing', async () => {
    const result = await withFailingCount(
      new Error('Connection refused at localhost:5432'),
      checkTablesExist,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Connection refused/);
    // Guessing "run db:push" at someone whose Postgres is down wastes their
    // time.
    expect(result.message).not.toMatch(/db:push/);
  });
});

/**
 * Make `prisma.company.count()` fail for the duration of one call.
 *
 * Hand-rolled rather than `vi.spyOn(...).mockRestore()`, which does not put a
 * Prisma model method back: `count` is not an own property of the model
 * object, so the spy adds one and restoring removes it, leaving the accessor
 * undefined for every test that runs afterwards. The first test to need a
 * working count after a spy is the one that finds out.
 */
async function withFailingCount<T>(error: Error, fn: () => Promise<T>): Promise<T> {
  const model = prisma.company as unknown as { count: unknown };
  const original = model.count;
  model.count = () => Promise.reject(error);
  try {
    return await fn();
  } finally {
    model.count = original;
  }
}

describe('the one sentence the boot log and the dashboard both print', () => {
  it('is silent on a healthy install', async () => {
    expect(await schemaProblem()).toBeNull();
  });

  it('carries the command to run when a table is missing', async () => {
    const message = await withFailingCount(
      new Error('The table `public.companies` does not exist in the current database.'),
      schemaProblem,
    );
    expect(message).toMatch(/pnpm db:push/);
  });
});
