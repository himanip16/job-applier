/**
 * Load the 50-LPA+ target list into the company table.
 *
 * Unlike add_companies.ts, the source/handle here are not guessed from the
 * domain: each was probed against the four board APIs the crawler supports and
 * the survivors verified to belong to the right company (several handles -
 * "linkedin", "slice", "navi", "fi", "eternal" - resolve to unrelated firms
 * with the same name, so a bare domain guess would have seeded garbage).
 * Anything that did not resolve stays on careers-page.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from './generated/prisma';

const prisma = new PrismaClient();

type Row = { company: string; domain: string; source: string; handle: string };
const rows: Row[] = JSON.parse(readFileSync(new URL('./companies_50lpa.json', import.meta.url), 'utf8'));

async function main() {
  let ats = 0, careers = 0, errors = 0;

  for (const r of rows) {
    try {
      await prisma.company.upsert({
        where: { source_handle: { source: r.source, handle: r.handle } },
        create: { name: r.company, source: r.source, handle: r.handle, enabled: true },
        update: { name: r.company, enabled: true },
      });
      r.source === 'careers-page' ? careers++ : ats++;
    } catch (err) {
      console.error(`x ${r.company}: ${(err as Error).message}`);
      errors++;
    }
  }

  console.log(`ATS boards: ${ats}  careers-page: ${careers}  errors: ${errors}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
