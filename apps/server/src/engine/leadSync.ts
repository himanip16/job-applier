import { prisma, type AppStatus, type LeadStatus } from '../lib/db.js';

/**
 * Keeps a Find-work card in step with its application:
 *
 *   run in flight (or waiting on you) -> Processing (SHORTLISTED + applicationId)
 *   submitted                         -> Applied
 *   failed or cancelled               -> back to For you, unlinked
 *
 * Processing is not its own LeadStatus: it is a Saved card with a run attached,
 * which leadListing splits into its own tab. Plain Saved never has one.
 */
type Target = { status: LeadStatus; linked: boolean };

function targetFor(app: AppStatus | null): Target {
  if (app === 'SUBMITTED') return { status: 'APPLIED', linked: true };
  if (app === null || app === 'FAILED' || app === 'CANCELLED') return { status: 'NEW', linked: false };
  return { status: 'SHORTLISTED', linked: true };
}

/**
 * Move the card(s) for this application to where its status says.
 *
 * Matched by the posting URL, which is what both records are keyed on, so a
 * run started from a pasted URL (Runs page, a job page) moves its card too.
 * Only ever updates existing leads - never creates one - and never moves an
 * Applied card on behalf of a different run.
 */
export async function syncLead(applicationId: string): Promise<void> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { status: true, profileId: true, job: { select: { url: true } } },
  });
  if (!application) return;
  const target = targetFor(application.status);
  await prisma.jobLead.updateMany({
    where: {
      profileId: application.profileId,
      url: application.job.url,
      OR: [
        // Submitting wins over a dismissal; a failed run does not undo one.
        { status: { in: target.status === 'APPLIED' ? ['NEW', 'SHORTLISTED', 'EXPIRED', 'REJECTED'] : ['NEW', 'SHORTLISTED', 'EXPIRED'] } },
        { status: 'APPLIED', applicationId },
      ],
    },
    data: { status: target.status, applicationId: target.linked ? applicationId : null, decidedAt: new Date() },
  });
}

/** A submitted application moves its card to Applied. */
export const markLeadApplied = syncLead;

/**
 * Re-sort every card a run has touched, from before Applied meant submitted:
 * each goes wherever its application says now, and Applied cards whose
 * application no longer exists go back to For you. Idempotent; run at boot.
 */
export async function reconcileLeads(): Promise<Record<string, number>> {
  const leads = await prisma.jobLead.findMany({
    where: { OR: [{ status: 'APPLIED' }, { status: 'SHORTLISTED', applicationId: { not: null } }] },
    select: { id: true, status: true, applicationId: true },
  });
  const ids = [...new Set(leads.map((l) => l.applicationId).filter((id): id is string => !!id))];
  const apps = new Map(
    (await prisma.application.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })).map(
      (a) => [a.id, a.status],
    ),
  );

  const moved: Record<string, number> = {};
  for (const lead of leads) {
    const target = targetFor(lead.applicationId ? (apps.get(lead.applicationId) ?? null) : null);
    const applicationId = target.linked ? lead.applicationId : null;
    if (target.status === lead.status && applicationId === lead.applicationId) continue;
    await prisma.jobLead.update({ where: { id: lead.id }, data: { status: target.status, applicationId } });
    const label = target.status === 'SHORTLISTED' ? 'Processing' : target.status === 'NEW' ? 'For you' : 'Applied';
    moved[label] = (moved[label] ?? 0) + 1;
  }
  return moved;
}

/** A run was queued: its card shows under Processing until the run ends. */
export async function markLeadProcessing(applicationId: string): Promise<void> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { profileId: true, job: { select: { url: true } } },
  });
  if (!application) return;
  await prisma.jobLead.updateMany({
    where: {
      profileId: application.profileId,
      url: application.job.url,
      OR: [{ status: { in: ['NEW', 'SHORTLISTED', 'EXPIRED'] } }, { status: 'APPLIED', applicationId }],
    },
    data: { status: 'SHORTLISTED', applicationId, decidedAt: new Date() },
  });
}
