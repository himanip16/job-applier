import 'dotenv/config';
import { PrismaClient } from '../../../../generated/prisma/index.js';

/**
 * Tests never touch the real database.
 *
 * The destructive suites used to switch DATABASE_URL to the test database
 * just before importing this file - but config.ts imports secrets.ts, which
 * imports this, so the client already existed, pointed at the real database,
 * by the time the switch happened. A test run on 2026-09-26 deleted a real
 * profile, answer bank and application history that way.
 *
 * So the rule lives here, where the client is made, and cannot be dodged by
 * import order: under vitest the client connects to TEST_DATABASE_URL and
 * nothing else, and refuses outright unless that database's name ends in
 * `_test`.
 */
function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? '';
  const name = (url.split('/').pop() ?? '').split('?')[0] ?? '';
  if (!/_test$/.test(name)) {
    throw new Error(
      `Tests refuse to use database "${name || '(unset)'}": set TEST_DATABASE_URL to a database ` +
        'whose name ends in _test. The real database is never used by tests.',
    );
  }
  return url;
}

export const prisma = process.env.VITEST
  ? new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } })
  : new PrismaClient();

export * from '../../../../generated/prisma/index.js';
