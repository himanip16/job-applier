/**
 * Guard for the suites that truncate tables.
 *
 * Pointing vitest at a dev DATABASE_URL by accident should not delete a real
 * answer bank, so the destructive suites refuse to start unless the database
 * name ends in _test.
 */
const { config } = await import('../src/lib/config.js');

export function requireTestDatabase(): string {
  const url = process.env.TEST_DATABASE_URL || config.testDatabaseUrl || config.databaseUrl || '';
  const name = (url.split('/').pop() ?? '').split('?')[0] ?? '';
  if (!/_test$/.test(name)) {
    throw new Error(
      `Refusing to run destructive tests against database "${name || '(unset)'}". ` +
        'Set TEST_DATABASE_URL (or DATABASE_URL) to a database whose name ends in _test, ' +
        'e.g. createdb job_applier_test && pnpm db:push.',
    );
  }
  // Prisma reads DATABASE_URL, so make the choice explicit for the client that
  // is about to be constructed.
  process.env.DATABASE_URL = url;
  return url;
}
