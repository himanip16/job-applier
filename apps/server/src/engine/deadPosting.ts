import type { Page } from 'playwright';
import { prisma } from '../lib/db.js';
import { postingStatus, saysClosed } from '../discovery/postingStatus.js';

/**
 * A posting that no longer exists is removed entirely - its run, its job and
 * its Find-work card - instead of being left as a failed run, or a card that
 * says Processing for a form nobody can reach.
 */

/** Thrown where a run finds out the posting is gone; the runner removes it. */
export class PostingGoneError extends Error {
  constructor(message = 'This job posting no longer exists.') {
    super(message);
    this.name = 'PostingGoneError';
  }
}

/**
 * The rendered page first, since it is what a client-rendered careers site
 * actually shows, then the posting URL itself (404, bounce to the job search,
 * expired JobPosting). "Unknown" is not gone.
 */
export async function postingGone(page: Page | null, url: string): Promise<boolean> {
  if (page && !page.isClosed()) {
    const text = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    if (saysClosed(text)) return true;
  }
  return (await postingStatus(url)) === 'closed';
}

/** Delete the run, every card for the posting except an Applied one, and the job if nothing else uses it. */
export async function removeDeadPosting(applicationId: string): Promise<void> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { profileId: true, jobId: true, job: { select: { url: true } } },
  });
  if (!app) return;
  await prisma.jobLead.deleteMany({ where: { profileId: app.profileId, url: app.job.url, status: { not: 'APPLIED' } } });
  await prisma.application.delete({ where: { id: applicationId } });
  // An earlier submitted application to the same posting keeps its job.
  await prisma.job.deleteMany({ where: { id: app.jobId, applications: { none: {} } } });
  console.log(`[runner] removed ${app.job.url}: the posting no longer exists`);
}
