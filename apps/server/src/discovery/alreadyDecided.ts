import { prisma } from '../lib/db.js';
import { canonicalUrl } from './jobSearchUtils.js';

/**
 * Postings the candidate has already dealt with, so neither a crawl nor the
 * For you queue offers them again.
 *
 * A URL is not enough on its own: boards re-list the same role under a new
 * requisition link, the same job turns up on the company board and an ATS,
 * and a run started from a pasted URL never had a lead at all. So a posting
 * also counts as decided when its company and title match one already
 * dismissed, saved, applied to or in a run.
 */

const CORPORATE_SUFFIX = /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|plc|gmbh)\b/g;
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Company + title, loosely: "Acme Pvt. Ltd." / "Software Engineer - II" equals "acme" / "software engineer ii". */
export function sameJobKey(company: string, title: string): string {
  const co = words(company).replace(CORPORATE_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return `${co}|${words(title)}`;
}

export interface Decided {
  /** Canonical URLs. */
  urls: Set<string>;
  /** sameJobKey of each. */
  jobs: Set<string>;
}

export async function decidedPostings(profileId: string): Promise<Decided> {
  const [leads, apps] = await Promise.all([
    prisma.jobLead.findMany({
      where: { profileId, status: { in: ['REJECTED', 'SHORTLISTED', 'APPLIED'] } },
      select: { url: true, companyName: true, title: true },
    }),
    // A failed or cancelled run sends its card back to For you on purpose (leadSync).
    prisma.application.findMany({
      where: { profileId, status: { notIn: ['FAILED', 'CANCELLED'] } },
      select: { job: { select: { url: true, company: true, title: true } } },
    }),
  ]);
  const decided: Decided = { urls: new Set(), jobs: new Set() };
  for (const l of leads) {
    decided.urls.add(canonicalUrl(l.url));
    decided.jobs.add(sameJobKey(l.companyName, l.title));
  }
  for (const { job } of apps) {
    decided.urls.add(canonicalUrl(job.url));
    // A run from a pasted URL is 'pending' until its page has been read.
    if (job.company !== 'pending' && job.title !== 'pending') decided.jobs.add(sameJobKey(job.company, job.title));
  }
  return decided;
}

export function isDecided(decided: Decided, posting: { url: string; companyName: string; title: string }): boolean {
  return decided.urls.has(canonicalUrl(posting.url)) || decided.jobs.has(sameJobKey(posting.companyName, posting.title));
}
