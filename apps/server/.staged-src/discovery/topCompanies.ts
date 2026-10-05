import { readFileSync } from 'node:fs';

/**
 * Where job search looks: the best-paying tech employers, and nowhere else.
 *
 * An open web search across every Greenhouse board finds whoever happens to
 * rank for the query - mostly small startups paying a fraction of the market.
 * The list in companies_50lpa.json is the other way round: companies chosen
 * because they pay, each with the board or careers-site crawler that reads
 * their openings. Search takes the top of that list by the upper end of the
 * SDE2 pay band, so the companies that pay most are always read first.
 */

export interface TargetCompany {
  company: string;
  domain: string;
  /** A Source id from sources.ts / careerSites.ts, or "careers-page". */
  source: string;
  handle: string;
  tier: string;
  /** SDE2 CTC band in lakhs per annum, as written: "70-150", "100+". */
  sde2_ctc_lpa: string;
  india_locations: string;
}

const LIST_URL = new URL('../../../../companies_50lpa.json', import.meta.url);

/** The top of the band, which is what "pays crazy well" means: "70-150" -> 150. */
export function payCeiling(band: string): number {
  const nums = (band.match(/\d+/g) ?? []).map(Number);
  return nums.length ? Math.max(...nums) : 0;
}

/**
 * The `limit` best-paying companies, highest ceiling first.
 *
 * Read fresh each call so editing the JSON takes effect on the next search
 * without restarting anything. Ties keep the file's own order, which already
 * puts quant firms and big tech ahead of the rest.
 */
export function topCompanies(limit = 50): TargetCompany[] {
  const rows = JSON.parse(readFileSync(LIST_URL, 'utf8')) as TargetCompany[];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => payCeiling(b.row.sde2_ctc_lpa) - payCeiling(a.row.sde2_ctc_lpa) || a.index - b.index)
    .slice(0, limit)
    .map(({ row }) => row);
}

/** What the target list knows about one company, for filtering and ranking leads. */
export interface CompanyFacts {
  tier: string;
  payCeiling: number;
}

/**
 * Every listed company by lower-cased name. A lead from a company not on the
 * list simply has no facts: its pay is unknown, not assumed.
 */
export function companyDirectory(): Map<string, CompanyFacts> {
  const rows = JSON.parse(readFileSync(LIST_URL, 'utf8')) as TargetCompany[];
  return new Map(rows.map((r) => [r.company.toLowerCase(), { tier: r.tier, payCeiling: payCeiling(r.sde2_ctc_lpa) }]));
}
