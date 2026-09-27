/**
 * Refresh companies_leetcode.json: LeetCode compensation and interview posts
 * for every company on the target list. Run by hand:
 *
 *   pnpm --filter @ja/server exec tsx src/discovery/leetcode/collectAll.ts
 *
 * Every figure in the output carries its post link and the exact lines it was
 * read from.
 */
import { writeFileSync } from 'node:fs';
import { collectSignals, type CompanySignals } from './signals.js';
import { topCompanies } from '../topCompanies.js';

const OUT = new URL('../../../../../companies_leetcode.json', import.meta.url);
const companies = topCompanies(1000).map((c) => c.company);
const now = Date.now();
const results: CompanySignals[] = [];

for (const [i, company] of companies.entries()) {
  try {
    const s = await collectSignals(company, companies, {
      compSince: new Date(now - 365 * 86_400_000),
      interviewSince: new Date(now - 90 * 86_400_000),
      maxCompPosts: 12,
      log: console.log,
    });
    results.push(s);
    console.log(`[${i + 1}/${companies.length}] ${company}: ${s.interviews.length} interview posts, ${s.comp.length} pay reports`);
  } catch (err) {
    console.log(`[${i + 1}/${companies.length}] ${company}: FAILED ${(err as Error).message}`);
  }
  // Written as it goes, so a stopped run keeps what it had.
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: 'leetcode.com/discuss', companies: results }, null, 2) + '\n');
}
