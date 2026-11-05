import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { validateApplicationEligibility, isEmergencyKillSwitchActive } from './applicationValidation.js';

/**
 * Application reliability layer.
 *
 * Provides:
 * - Atomic lead claiming (prevents race conditions)
 * - Duplicate application prevention
 * - Company exclusion checks
 * - Location and work-mode validation
 * - Salary and experience validation
 * - Application budget tracking
 * - Retry policy with exponential backoff
 * - Dead-letter queue for permanently failed applications
 * - Job expiry detection
 * - Emergency kill switch check
 */

/**
 * Claim a lead atomically for application.
 *
 * Uses optimistic concurrency control to prevent multiple processes from
 * claiming the same lead simultaneously. Returns false if the lead was already
 * claimed or cannot be claimed.
 */
export async function claimLeadForApplication(
  profileId: string,
  leadId: string,
): Promise<{ success: boolean; reason?: string; applicationId?: string }> {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.jobLead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        status: true,
        applicationId: true,
        version: true,
        url: true,
        expiresAt: true,
      },
    });

    if (!lead) {
      return { success: false, reason: 'Lead not found' };
    }

    // Check if lead belongs to this profile
    const ownedLead = await tx.jobLead.findFirst({
      where: { id: leadId, profileId },
    });
    if (!ownedLead) {
      return { success: false, reason: 'Lead does not belong to this profile' };
    }

    // Check if already applied
    if (lead.status === 'APPLIED' || lead.applicationId) {
      return { success: false, reason: 'Already applied to this job' };
    }

    // Check if expired
    if (lead.expiresAt && lead.expiresAt < new Date()) {
      await tx.jobLead.update({
        where: { id: leadId },
        data: { status: 'EXPIRED' },
      });
      return { success: false, reason: 'Job posting has expired' };
    }

    // Check if already claimed by another process (optimistic concurrency)
    if (lead.status !== 'NEW' && lead.status !== 'SHORTLISTED') {
      return { success: false, reason: 'Lead is not available for application' };
    }

    // Check company exclusions
    const excluded = await tx.companyExclusion.findFirst({
      where: {
        profileId,
        companyKey: ownedLead.companyName.toLowerCase().replace(/[^a-z0-9]/g, ''),
      },
    });
    if (excluded) {
      return { success: false, reason: `Company excluded: ${excluded.reason || 'No reason provided'}` };
    }

    // Check emergency kill switch
    const killSwitchActive = await isEmergencyKillSwitchActive();
    if (killSwitchActive) {
      return { success: false, reason: 'Emergency kill switch is active - all applications are blocked' };
    }

    // Update lead status atomically with version check
    const updated = await tx.jobLead.updateMany({
      where: {
        id: leadId,
        version: lead.version,
      },
      data: {
        status: 'SHORTLISTED',
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      return { success: false, reason: 'Lead was claimed by another process' };
    }

    return { success: true };
  });
}

/**
 * Check if an application can be created (duplicate prevention).
 *
 * Returns the existing application if one exists, or null if creation is allowed.
 */
export async function checkDuplicateApplication(
  profileId: string,
  jobUrl: string,
): Promise<{ exists: boolean; applicationId?: string; status?: string }> {
  const existing = await prisma.application.findFirst({
    where: {
      profileId,
      job: { url: jobUrl },
    },
    select: { id: true, status: true },
  });

  if (existing) {
    return { exists: true, applicationId: existing.id, status: existing.status };
  }

  return { exists: false };
}

/**
 * Schedule a retry for a failed application with exponential backoff.
 */
export async function scheduleRetry(applicationId: string, error: string): Promise<void> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { retryCount: true, status: true },
  });

  if (!app || app.status === 'SUBMITTED') {
    return;
  }

  if (app.retryCount >= config.maxApplicationRetries) {
    // Move to dead-letter queue
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        deadLettered: true,
        deadLetterReason: `Max retries (${config.maxApplicationRetries}) exceeded. Last error: ${error}`,
        status: 'FAILED',
      },
    });
    return;
  }

  // Calculate exponential backoff: 2^retryCount * base_delay (min 5min, max 24h)
  const baseDelayMs = 5 * 60 * 1000; // 5 minutes
  const backoffMs = Math.min(baseDelayMs * Math.pow(2, app.retryCount), 24 * 60 * 60 * 1000);
  const nextRetryAt = new Date(Date.now() + backoffMs);

  await prisma.application.update({
    where: { id: applicationId },
    data: {
      retryCount: { increment: 1 },
      lastRetryAt: new Date(),
      nextRetryAt,
      status: 'QUEUED',
      blockedReason: null,
    },
  });
}

/**
 * Get applications ready for retry (nextRetryAt has passed).
 */
export async function getApplicationsReadyForRetry(): Promise<string[]> {
  const apps = await prisma.application.findMany({
    where: {
      status: 'QUEUED',
      nextRetryAt: { lte: new Date() },
      deadLettered: false,
    },
    select: { id: true },
  });

  return apps.map((a) => a.id);
}

/**
 * Mark expired job leads.
 *
 * Marks leads as EXPIRED if their expiresAt has passed or if they're older
 * than the configured expiry days.
 */
export async function markExpiredLeads(): Promise<number> {
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() - config.jobExpiryDays);

  const result = await prisma.jobLead.updateMany({
    where: {
      status: 'NEW',
      OR: [
        { expiresAt: { lte: new Date() } },
        { discoveredAt: { lte: expiryDate } },
      ],
    },
    data: { status: 'EXPIRED' },
  });

  return result.count;
}

/**
 * Add a company to the exclusion list.
 */
export async function excludeCompany(
  profileId: string,
  companyName: string,
  reason?: string,
): Promise<void> {
  const companyKey = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');

  await prisma.companyExclusion.upsert({
    where: { profileId_companyKey: { profileId, companyKey } },
    create: {
      profileId,
      companyKey,
      companyName,
      reason,
    },
    update: {
      companyName,
      reason,
    },
  });
}

/**
 * Remove a company from the exclusion list.
 */
export async function removeCompanyExclusion(profileId: string, companyName: string): Promise<void> {
  const companyKey = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');

  await prisma.companyExclusion.deleteMany({
    where: { profileId, companyKey },
  });
}

/**
 * Get all excluded companies for a profile.
 */
export async function getExcludedCompanies(profileId: string): Promise<Array<{ companyName: string; reason?: string }>> {
  const exclusions = await prisma.companyExclusion.findMany({
    where: { profileId },
    select: { companyName: true, reason: true },
  });

  return exclusions.map((e) => ({ companyName: e.companyName, reason: e.reason ?? undefined }));
}

/**
 * Validate that a profile has the minimum required information for applications.
 *
 * Returns { valid: true } if the profile is ready, or { valid: false, missing: [] }
 * with a list of missing required fields.
 */
export async function validateProfile(profileId: string): Promise<{ valid: boolean; missing: string[] }> {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      email: true,
      fullName: true,
      firstName: true,
      lastName: true,
      phone: true,
      resumeText: true,
      resumes: { select: { id: true } },
    },
  });

  if (!profile) {
    return { valid: false, missing: ['Profile not found'] };
  }

  const missing: string[] = [];

  if (!profile.email) missing.push('Email');
  if (!profile.fullName) missing.push('Full name');
  if (!profile.firstName) missing.push('First name');
  if (!profile.lastName) missing.push('Last name');
  if (!profile.phone) missing.push('Phone number');
  if (!profile.resumeText && profile.resumes.length === 0) missing.push('Resume');

  return { valid: missing.length === 0, missing };
}
