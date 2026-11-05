import { prisma, Prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { logger, createProfileLogger } from '../lib/logger.js';

/**
 * Application validation layer.
 *
 * Provides comprehensive validation checks before creating or submitting applications:
 * - Location and work-mode validation
 * - Salary and experience eligibility checks
 * - Application budget tracking
 * - Company blacklist validation
 * - Emergency kill switch check
 * - Dry-run mode handling
 */

export interface ValidationResult {
  passed: boolean;
  category: string;
  reason: string;
  context?: Record<string, unknown>;
}

export interface ValidationReport {
  allPassed: boolean;
  results: ValidationResult[];
  blockedByKillSwitch: boolean;
  isDryRun: boolean;
}

/**
 * Validate all application eligibility checks.
 *
 * Runs all configured validation checks and returns a comprehensive report.
 */
export async function validateApplicationEligibility(
  profileId: string,
  job: {
    id?: string;
    url: string;
    company: string;
    title: string;
    location?: string | null;
    descriptionText?: string | null;
    workMode?: 'ON_SITE' | 'HYBRID' | 'REMOTE' | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
    experienceMin?: number | null;
    experienceMax?: number | null;
  },
  leadId?: string,
  applicationId?: string,
): Promise<ValidationReport> {
  const results: ValidationResult[] = [];
  const profileLogger = createProfileLogger(profileId, 'unknown');

  // Check emergency kill switch first
  const killSwitchActive = await isEmergencyKillSwitchActive();
  if (killSwitchActive) {
    results.push({
      passed: false,
      category: 'EMERGENCY_KILL_SWITCH',
      reason: 'Emergency kill switch is active - all applications are blocked',
    });
    return {
      allPassed: false,
      results,
      blockedByKillSwitch: true,
      isDryRun: config.dryRunMode,
    };
  }

  // Check if dry-run mode is enabled
  if (config.dryRunMode) {
    profileLogger.info('[validation] Dry-run mode enabled - will simulate applications');
  }

  // Fetch profile with all relevant fields
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      city: true,
      region: true,
      country: true,
      preferredLocation: true,
      preferredWorkMode: true,
      willingToRelocate: true,
      yearsOfExperience: true,
      currentCTC: true,
      expectedCTC: true,
    },
  });

  if (!profile) {
    results.push({
      passed: false,
      category: 'PROFILE_NOT_FOUND',
      reason: 'Profile not found',
    });
    return {
      allPassed: false,
      results,
      blockedByKillSwitch: false,
      isDryRun: config.dryRunMode,
    };
  }

  // Location validation
  if (config.validateLocation) {
    const locationResult = await validateLocation(profile, job);
    results.push(locationResult);
  }

  // Work-mode validation
  if (config.validateWorkMode) {
    const workModeResult = await validateWorkMode(profile, job);
    results.push(workModeResult);
  }

  // Salary validation
  if (config.validateSalary) {
    const salaryResult = await validateSalary(profile, job);
    results.push(salaryResult);
  }

  // Experience validation
  if (config.validateExperience) {
    const experienceResult = await validateExperience(profile, job);
    results.push(experienceResult);
  }

  // Budget validation
  const budgetResult = await validateApplicationBudget(profileId);
  results.push(budgetResult);

  // Record all validation results in the database
  await recordValidationResults(profileId, job.id, leadId, applicationId, results);

  const allPassed = results.every((r) => r.passed);

  if (!allPassed) {
    const failures = results.filter((r) => !r.passed);
    profileLogger.warn(
      { failures: failures.map((f) => ({ category: f.category, reason: f.reason })) },
      '[validation] Application validation failed',
    );
  }

  return {
    allPassed,
    results,
    blockedByKillSwitch: false,
    isDryRun: config.dryRunMode,
  };
}

/**
 * Validate job location against profile preferences.
 */
async function validateLocation(
  profile: {
    city?: string | null;
    region?: string | null;
    country?: string | null;
    preferredLocation?: string | null;
    willingToRelocate: boolean;
  },
  job: { location?: string | null },
): Promise<ValidationResult> {
  // If job has no location specified, skip validation
  if (!job.location) {
    return {
      passed: true,
      category: 'LOCATION',
      reason: 'Job location not specified - skipping validation',
    };
  }

  // If profile has no location preferences, skip validation
  if (!profile.preferredLocation && !profile.city) {
    return {
      passed: true,
      category: 'LOCATION',
      reason: 'No location preferences set - skipping validation',
    };
  }

  const jobLocationLower = job.location.toLowerCase();
  const preferredLocationLower = (profile.preferredLocation || profile.city || '').toLowerCase();

  // Check if job is remote (candidate's preferred location doesn't matter)
  if (jobLocationLower.includes('remote')) {
    return {
      passed: true,
      category: 'LOCATION',
      reason: 'Job is remote - location constraint not applicable',
    };
  }

  // Check if candidate is willing to relocate
  if (profile.willingToRelocate) {
    return {
      passed: true,
      category: 'LOCATION',
      reason: 'Candidate willing to relocate - location constraint waived',
    };
  }

  // Check if job location matches preferred location
  if (preferredLocationLower && jobLocationLower.includes(preferredLocationLower)) {
    return {
      passed: true,
      category: 'LOCATION',
      reason: 'Job location matches candidate preferences',
      context: { jobLocation: job.location, preferredLocation: profile.preferredLocation },
    };
  }

  // Check if job location matches candidate's current location
  const currentLocation = [profile.city, profile.region, profile.country].filter(Boolean).join(', ').toLowerCase();
  if (currentLocation && jobLocationLower.includes(currentLocation)) {
    return {
      passed: true,
      category: 'LOCATION',
      reason: 'Job location matches candidate current location',
      context: { jobLocation: job.location, currentLocation },
    };
  }

  return {
    passed: false,
    category: 'LOCATION',
    reason: `Job location (${job.location}) does not match candidate preferences (${profile.preferredLocation || currentLocation})`,
    context: { jobLocation: job.location, preferredLocation: profile.preferredLocation, currentLocation },
  };
}

/**
 * Validate work mode against profile preferences.
 */
async function validateWorkMode(
  profile: { preferredWorkMode?: 'ON_SITE' | 'HYBRID' | 'REMOTE' | null },
  job: { workMode?: 'ON_SITE' | 'HYBRID' | 'REMOTE' | null; location?: string | null },
): Promise<ValidationResult> {
  // If job has no work mode specified, skip validation
  if (!job.workMode) {
    // Try to infer from location string
    if (job.location) {
      const locationLower = job.location.toLowerCase();
      if (locationLower.includes('remote')) {
        return {
          passed: true,
          category: 'WORK_MODE',
          reason: 'Job appears to be remote (inferred from location)',
        };
      }
    }
    return {
      passed: true,
      category: 'WORK_MODE',
      reason: 'Job work mode not specified - skipping validation',
    };
  }

  // If profile has no work mode preference, skip validation
  if (!profile.preferredWorkMode) {
    return {
      passed: true,
      category: 'WORK_MODE',
      reason: 'No work mode preference set - skipping validation',
    };
  }

  // Work mode compatibility matrix
  const compatibleModes: Record<string, string[]> = {
    ON_SITE: ['ON_SITE', 'HYBRID'],
    HYBRID: ['HYBRID', 'REMOTE', 'ON_SITE'],
    REMOTE: ['REMOTE', 'HYBRID'],
  };

  const allowedModes = compatibleModes[profile.preferredWorkMode] || [];

  if (allowedModes.includes(job.workMode)) {
    return {
      passed: true,
      category: 'WORK_MODE',
      reason: `Job work mode (${job.workMode}) is compatible with candidate preference (${profile.preferredWorkMode})`,
      context: { jobWorkMode: job.workMode, preferredWorkMode: profile.preferredWorkMode },
    };
  }

  return {
    passed: false,
    category: 'WORK_MODE',
    reason: `Job work mode (${job.workMode}) is not compatible with candidate preference (${profile.preferredWorkMode})`,
    context: { jobWorkMode: job.workMode, preferredWorkMode: profile.preferredWorkMode },
  };
}

/**
 * Validate salary expectations against job salary range.
 */
async function validateSalary(
  profile: { expectedCTC?: string | null },
  job: { salaryMin?: number | null; salaryMax?: number | null },
): Promise<ValidationResult> {
  // If job has no salary range, skip validation
  if (!job.salaryMin && !job.salaryMax) {
    return {
      passed: true,
      category: 'SALARY',
      reason: 'Job salary range not specified - skipping validation',
    };
  }

  // If profile has no salary expectation, skip validation
  if (!profile.expectedCTC) {
    return {
      passed: true,
      category: 'SALARY',
      reason: 'No salary expectation set - skipping validation',
    };
  }

  // Parse expected CTC (assume it's a number or string with numbers)
  const expectedSalaryMatch = profile.expectedCTC.match(/[\d,]+/);
  if (!expectedSalaryMatch) {
    return {
      passed: true,
      category: 'SALARY',
      reason: 'Could not parse salary expectation - skipping validation',
    };
  }

  const expectedSalary = parseInt(expectedSalaryMatch[0].replace(/,/g, ''), 10);

  // Check if expected salary is below job minimum
  if (job.salaryMin && expectedSalary < job.salaryMin) {
    return {
      passed: false,
      category: 'SALARY',
      reason: `Expected salary (${expectedSalary}) is below job minimum (${job.salaryMin})`,
      context: { expectedSalary, jobSalaryMin: job.salaryMin, jobSalaryMax: job.salaryMax },
    };
  }

  // Check if expected salary is significantly above job maximum (more than 20%)
  if (job.salaryMax && expectedSalary > job.salaryMax * 1.2) {
    return {
      passed: false,
      category: 'SALARY',
      reason: `Expected salary (${expectedSalary}) is significantly above job maximum (${job.salaryMax})`,
      context: { expectedSalary, jobSalaryMin: job.salaryMin, jobSalaryMax: job.salaryMax },
    };
  }

  return {
    passed: true,
    category: 'SALARY',
    reason: 'Salary expectations are within acceptable range',
    context: { expectedSalary, jobSalaryMin: job.salaryMin, jobSalaryMax: job.salaryMax },
  };
}

/**
 * Validate experience requirements against candidate experience.
 */
async function validateExperience(
  profile: { yearsOfExperience?: number | null },
  job: { experienceMin?: number | null; experienceMax?: number | null },
): Promise<ValidationResult> {
  // If job has no experience requirements, skip validation
  if (!job.experienceMin && !job.experienceMax) {
    return {
      passed: true,
      category: 'EXPERIENCE',
      reason: 'Job experience requirements not specified - skipping validation',
    };
  }

  // If profile has no experience data, skip validation with a warning
  if (profile.yearsOfExperience === null || profile.yearsOfExperience === undefined) {
    return {
      passed: true,
      category: 'EXPERIENCE',
      reason: 'Candidate experience not set - skipping validation (please update profile)',
    };
  }

  // Check if candidate has less than minimum required experience
  if (job.experienceMin && profile.yearsOfExperience < job.experienceMin) {
    return {
      passed: false,
      category: 'EXPERIENCE',
      reason: `Candidate experience (${profile.yearsOfExperience} years) is below minimum required (${job.experienceMin} years)`,
      context: { candidateExperience: profile.yearsOfExperience, jobExperienceMin: job.experienceMin, jobExperienceMax: job.experienceMax },
    };
  }

  // Check if candidate has significantly more than maximum required experience (more than 50%)
  if (job.experienceMax && profile.yearsOfExperience > job.experienceMax * 1.5) {
    return {
      passed: false,
      category: 'EXPERIENCE',
      reason: `Candidate experience (${profile.yearsOfExperience} years) is significantly above maximum required (${job.experienceMax} years)`,
      context: { candidateExperience: profile.yearsOfExperience, jobExperienceMin: job.experienceMin, jobExperienceMax: job.experienceMax },
    };
  }

  return {
    passed: true,
    category: 'EXPERIENCE',
    reason: 'Candidate experience meets requirements',
    context: { candidateExperience: profile.yearsOfExperience, jobExperienceMin: job.experienceMin, jobExperienceMax: job.experienceMax },
  };
}

/**
 * Validate application budget for the current time window.
 */
async function validateApplicationBudget(profileId: string): Promise<ValidationResult> {
  const now = new Date();

  // Check daily budget
  if (config.maxApplicationsPerDay > 0) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const dailyCount = await prisma.application.count({
      where: {
        profileId,
        status: 'SUBMITTED',
        submittedAt: { gte: dayStart, lt: dayEnd },
      },
    });

    if (dailyCount >= config.maxApplicationsPerDay) {
      return {
        passed: false,
        category: 'BUDGET',
        reason: `Daily application limit reached (${dailyCount}/${config.maxApplicationsPerDay})`,
        context: { window: 'DAILY', count: dailyCount, limit: config.maxApplicationsPerDay },
      };
    }
  }

  // Check weekly budget
  if (config.maxApplicationsPerWeek > 0) {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
    weekStart.setHours(0, 0, 0, 0);

    const weeklyCount = await prisma.application.count({
      where: {
        profileId,
        status: 'SUBMITTED',
        submittedAt: { gte: weekStart },
      },
    });

    if (weeklyCount >= config.maxApplicationsPerWeek) {
      return {
        passed: false,
        category: 'BUDGET',
        reason: `Weekly application limit reached (${weeklyCount}/${config.maxApplicationsPerWeek})`,
        context: { window: 'WEEKLY', count: weeklyCount, limit: config.maxApplicationsPerWeek },
      };
    }
  }

  // Check monthly budget
  if (config.maxApplicationsPerMonth > 0) {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyCount = await prisma.application.count({
      where: {
        profileId,
        status: 'SUBMITTED',
        submittedAt: { gte: monthStart },
      },
    });

    if (monthlyCount >= config.maxApplicationsPerMonth) {
      return {
        passed: false,
        category: 'BUDGET',
        reason: `Monthly application limit reached (${monthlyCount}/${config.maxApplicationsPerMonth})`,
        context: { window: 'MONTHLY', count: monthlyCount, limit: config.maxApplicationsPerMonth },
      };
    }
  }

  return {
    passed: true,
    category: 'BUDGET',
    reason: 'Application budget within limits',
    context: {
      dailyLimit: config.maxApplicationsPerDay,
      weeklyLimit: config.maxApplicationsPerWeek,
      monthlyLimit: config.maxApplicationsPerMonth,
    },
  };
}

/**
 * Check if the emergency kill switch is active.
 */
export async function isEmergencyKillSwitchActive(): Promise<boolean> {
  if (config.emergencyKillSwitchEnabled) {
    return true;
  }

  const killSwitch = await prisma.emergencyKillSwitch.findFirst();
  return killSwitch?.enabled ?? false;
}

/**
 * Toggle the emergency kill switch.
 */
export async function toggleEmergencyKillSwitch(
  enabled: boolean,
  enabledBy?: string,
  reason?: string,
): Promise<void> {
  await prisma.emergencyKillSwitch.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      enabled,
      enabledBy,
      reason,
      enabledAt: enabled ? new Date() : null,
    },
    update: {
      enabled,
      enabledBy,
      reason,
      enabledAt: enabled ? new Date() : null,
    },
  });

  logger.info(
    { enabled, enabledBy, reason },
    '[kill-switch] Emergency kill switch toggled',
  );
}

/**
 * Record validation results in the database.
 */
async function recordValidationResults(
  profileId: string,
  jobId: string | undefined,
  leadId: string | undefined,
  applicationId: string | undefined,
  results: ValidationResult[],
): Promise<void> {
  await prisma.validationResult.createMany({
    data: results.map((r) => ({
      profileId,
      jobId,
      leadId,
      applicationId,
      category: r.category as any,
      passed: r.passed,
      reason: r.reason,
      context: r.context as any,
    })),
  });
}

/**
 * Get application budget status for a profile.
 */
export async function getApplicationBudgetStatus(profileId: string) {
  const now = new Date();

  // Daily
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const dailyCount = await prisma.application.count({
    where: {
      profileId,
      status: 'SUBMITTED',
      submittedAt: { gte: dayStart, lt: dayEnd },
    },
  });

  // Weekly
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weeklyCount = await prisma.application.count({
    where: {
      profileId,
      status: 'SUBMITTED',
      submittedAt: { gte: weekStart },
    },
  });

  // Monthly
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthlyCount = await prisma.application.count({
    where: {
      profileId,
      status: 'SUBMITTED',
      submittedAt: { gte: monthStart },
    },
  });

  return {
    daily: { count: dailyCount, limit: config.maxApplicationsPerDay, remaining: Math.max(0, config.maxApplicationsPerDay - dailyCount) },
    weekly: { count: weeklyCount, limit: config.maxApplicationsPerWeek, remaining: Math.max(0, config.maxApplicationsPerWeek - weeklyCount) },
    monthly: { count: monthlyCount, limit: config.maxApplicationsPerMonth, remaining: Math.max(0, config.maxApplicationsPerMonth - monthlyCount) },
  };
}
