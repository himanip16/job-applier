import { prisma } from '../lib/db.js';

/**
 * A submitted application moves its Find-work card to Applied.
 *
 * Leads applied to from the card are already APPLIED, but a run started from
 * a pasted URL (Runs page, a job page without a lead) never touched the lead,
 * so the job sat in "For you" after it went through. Matched by the posting
 * URL, which is what both records are keyed on.
 *
 * Idempotent: the status guard makes a repeat a no-op, and it only ever
 * updates an existing lead - never creates one.
 */
export async function markLeadApplied(applicationId: string): Promise<void> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { profileId: true, job: { select: { url: true } } },
  });
  if (!application) return;
  await prisma.jobLead.updateMany({
    where: { profileId: application.profileId, url: application.job.url, status: { not: 'APPLIED' } },
    data: { status: 'APPLIED', applicationId, decidedAt: new Date() },
  });
}
