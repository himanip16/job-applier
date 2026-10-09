import { prisma } from '../lib/db.js';

/**
 * When each careers site was last read, so a site is not read twice in a row.
 *
 * The record is `Company.lastCrawledAt`: both the per-company crawl
 * (crawler.ts) and the best-paying-companies search (findJobs.ts) write it
 * after a successful read, and both skip a site read within the window. A
 * posting list does not change much in a few hours, and re-reading it costs
 * the site a load and you nothing but "already seen".
 *
 * Failed reads do not count - lastCrawlNote starts with "failed" - so a site
 * that was down is tried again on the next run.
 */
export const RECRAWL_AFTER_MS = 4 * 60 * 60 * 1000;

const key = (source: string, handle: string) => `${source}\u0000${handle}`;

export function crawledRecently(
  company: { lastCrawledAt: Date | null; lastCrawlNote: string | null },
  now = Date.now(),
): boolean {
  if (!company.lastCrawledAt) return false;
  if (company.lastCrawlNote?.startsWith('failed')) return false;
  return now - company.lastCrawledAt.getTime() < RECRAWL_AFTER_MS;
}

/** The sites among `refs` read successfully within the window, with when. */
export async function recentCrawls(
  refs: { source: string; handle: string }[],
): Promise<Map<string, Date>> {
  if (!refs.length) return new Map();
  const rows = await prisma.company.findMany({
    where: {
      OR: refs.map((r) => ({ source: r.source, handle: r.handle })),
      lastCrawledAt: { gte: new Date(Date.now() - RECRAWL_AFTER_MS) },
    },
    select: { source: true, handle: true, lastCrawledAt: true, lastCrawlNote: true },
  });
  const recent = new Map<string, Date>();
  for (const row of rows) if (crawledRecently(row)) recent.set(key(row.source, row.handle), row.lastCrawledAt!);
  return recent;
}

export const crawlKey = key;

export async function markCrawled(companyId: string, note: string): Promise<void> {
  await prisma.company.update({ where: { id: companyId }, data: { lastCrawledAt: new Date(), lastCrawlNote: note } });
}

/** "2h 15m ago", for notes. */
export function ago(at: Date, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}
