import { existsSync, readFileSync, statSync } from 'node:fs';
import { isComparison, type CompanySignals } from './signals.js';

/**
 * companies_leetcode.json, summarised per company for the job list.
 *
 * Every number here is a summary of figures people reported, with how many
 * there were: a median of three reported base salaries, never an estimate. A
 * company with no reports has no pay, and shows none. Entry-level offers are
 * kept out of the medians (see ENTRY_LEVEL).
 */

export interface CompanyReport {
  /** Median of reported base salaries, in LPA. */
  baseMedian: number | null;
  /** Median of reported first-year totals, in LPA. */
  totalMedian: number | null;
  /** How many posts reported a base / a total. */
  baseReports: number;
  totalReports: number;
  /** Interview-experience posts naming this company in the last 90 days. */
  interviews90d: number;
  /** Where to read them. */
  links: { title: string; url: string; date: string; kind: 'pay' | 'interview' }[];
}

const FILE = new URL('../../../../../companies_leetcode.json', import.meta.url);

let cache: { mtime: number; byCompany: Map<string, CompanyReport> } | null = null;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 10) / 10;
};

/**
 * Offers to students and new graduates. They are real, but a median that
 * includes them says "19 LPA" about a company that pays an experienced
 * engineer three times that, so they are left out of the numbers (their links
 * still show).
 */
const ENTRY_LEVEL = /\b(intern|internship|new ?grad|fresher|campus|ppo|graduate|20(2[5-9])\s*(grad|batch|passout))\b/i;

/** By lower-cased company name. Re-read whenever the file changes; empty if it has never been collected. */
export function leetcodeReports(): Map<string, CompanyReport> {
  if (!existsSync(FILE)) return new Map();
  const mtime = statSync(FILE).mtimeMs;
  if (cache?.mtime === mtime) return cache.byCompany;

  const data = JSON.parse(readFileSync(FILE, 'utf8')) as { companies: CompanySignals[] };
  const byCompany = new Map<string, CompanyReport>();
  for (const c of data.companies) {
    // Collected before comparison posts were skipped; filter them here too.
    const attributable = c.comp.filter((f) => !isComparison(f.post.title));
    const experienced = attributable.filter((f) => !ENTRY_LEVEL.test(`${f.post.title} ${f.level ?? ''}`));
    const bases = experienced.flatMap((f) => (f.baseLpa !== undefined ? [f.baseLpa] : []));
    const totals = experienced.flatMap((f) => (f.totalLpa !== undefined ? [f.totalLpa] : []));
    byCompany.set(c.company.toLowerCase(), {
      baseMedian: median(bases),
      totalMedian: median(totals),
      baseReports: bases.length,
      totalReports: totals.length,
      interviews90d: c.interviews.length,
      links: [
        ...attributable.map((f) => ({ title: f.post.title, url: f.post.url, date: f.post.createdAt.slice(0, 10), kind: 'pay' as const })),
        ...c.interviews.slice(0, 5).map((p) => ({ title: p.title, url: p.url, date: p.createdAt.slice(0, 10), kind: 'interview' as const })),
      ],
    });
  }
  cache = { mtime, byCompany };
  return byCompany;
}
