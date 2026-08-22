import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { prisma } from './db.js';

/**
 * Does the generated Prisma client actually match the schema on disk?
 *
 * `generated/` is gitignored, so pulling a branch that adds a model leaves you
 * with a client that has never heard of it. Every call then fails as
 * `Cannot read properties of undefined (reading 'count')` from whichever
 * endpoint touched it first - which names neither the model nor the fix, and
 * repeats on every poll until you go and read the source.
 *
 * Checking at boot turns that into one sentence with the command in it.
 *
 * The model list is read from schema.prisma rather than hardcoded, so this
 * keeps working for models added later without anyone remembering to update
 * it.
 */
export interface SchemaCheck {
  ok: boolean;
  missingModels: string[];
  message?: string;
}

export async function checkGeneratedClient(
  /**
   * The client to inspect. Injectable so the check itself can be tested:
   * the Prisma client exposes models through getters, so a test cannot
   * simulate a stale one by deleting properties off the real object.
   */
  client: Record<string, unknown> = prisma as unknown as Record<string, unknown>,
): Promise<SchemaCheck> {
  let schema: string;
  try {
    schema = await readFile(path.join(config.repoRoot, 'prisma', 'schema.prisma'), 'utf8');
  } catch {
    // No schema to compare against - not our problem to diagnose.
    return { ok: true, missingModels: [] };
  }

  const declared = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);

  const missingModels = declared.filter((name) => {
    // Prisma exposes `model Foo` as `prisma.foo`, lower-casing only the first
    // character: `InterviewRound` -> `interviewRound`.
    const accessor = name.charAt(0).toLowerCase() + name.slice(1);
    return typeof client[accessor] !== 'object' || client[accessor] === null;
  });

  if (!missingModels.length) return { ok: true, missingModels: [] };

  return {
    ok: false,
    missingModels,
    message:
      `The generated Prisma client is out of date: it has no ${missingModels
        .map((m) => `\`${m}\``)
        .join(', ')}. ` +
      'This happens after pulling a branch that adds a model, because generated/ is not committed. ' +
      'Run `pnpm db:push` to regenerate the client and create the matching tables ' +
      '(or `pnpm db:generate` alone if the database is already up to date).',
  };
}

/**
 * Do the tables actually exist?
 *
 * A regenerated client still fails if `db push` was never run - differently,
 * and later, with a Prisma P2021. Cheap to rule out at boot with one query
 * against a table only the newer migrations create.
 */
export async function checkTablesExist(): Promise<{ ok: boolean; message?: string }> {
  try {
    await prisma.company.count();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/does not exist|P2021|relation .* does not exist/i.test(message)) {
      return {
        ok: false,
        message:
          'The database is missing tables the schema declares. Run `pnpm db:push` to create them.',
      };
    }
    // Anything else (no connection, bad credentials) is reported verbatim -
    // guessing at it would be worse than the real message.
    return { ok: false, message: `Could not reach the database: ${message}` };
  }
}

/**
 * The first thing wrong with the install, as one actionable sentence.
 *
 * Both checks describe the same class of problem - "you pulled code and did
 * not run db:push" - and the caller almost never cares which of the two
 * tripped, only what to type. Ordered deliberately: a stale client makes the
 * table check meaningless, so it is reported first.
 */
export async function schemaProblem(): Promise<string | null> {
  const client = await checkGeneratedClient();
  if (!client.ok) return client.message!;
  const tables = await checkTablesExist();
  if (!tables.ok) return tables.message!;
  return null;
}
