import { prisma } from '../lib/db.js';

/**
 * Register the company so the per-company crawler picks it up from now on.
 *
 * This is what stops search from being a parallel universe. Search finds Acme
 * once; after that Acme is a board like any other you added by hand, its
 * future postings arrive through the ordinary crawl, and no credits are spent
 * re-finding it.
 */
export async function registerCompany(
  /** A source id and its handle - a BoardRef, or any crawler in careerSites.ts. */
  ref: { ats: string; slug: string },
  name: string,
): Promise<{ id: string; created: boolean }> {
  const found = await prisma.company.findUnique({
    where: { source_handle: { source: ref.ats, handle: ref.slug } },
  });
  if (found) return { id: found.id, created: false };
  const created = await prisma.company.create({
    data: { name, source: ref.ats, handle: ref.slug, enabled: true, lastCrawledAt: new Date() },
  });
  return { id: created.id, created: true };
}
