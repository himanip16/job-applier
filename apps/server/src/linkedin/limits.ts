import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';

/**
 * How much outreach may leave this account, and how much already has.
 *
 * These caps are not politeness. LinkedIn enforces its own invitation limit —
 * roughly a hundred a week, tightening automatically when a large share go
 * unaccepted — and an account that trips it loses the ability to connect with
 * anyone for weeks, including the people you would have written to by hand.
 * The defaults here sit well under that, and the weekly one is tracked
 * separately because invitations are what LinkedIn actually counts.
 *
 * Every number is a floor on caution, not a target. Nothing in this file
 * causes a send; it only ever refuses one.
 */

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export interface OutreachQuota {
  sentLastHour: number;
  sentToday: number;
  invitesThisWeek: number;
  hourLimit: number;
  dayLimit: number;
  weeklyInviteLimit: number;
  /** Null when there is room, otherwise the sentence explaining the refusal. */
  blockedReason: string | null;
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000);

export async function outreachQuota(profileId: string): Promise<OutreachQuota> {
  const [sentLastHour, sentToday, invitesThisWeek] = await Promise.all([
    prisma.outreachMessage.count({
      where: { profileId, status: 'SENT', sentAt: { gte: hoursAgo(1) } },
    }),
    prisma.outreachMessage.count({
      where: { profileId, status: 'SENT', sentAt: { gte: hoursAgo(24) } },
    }),
    // Only invitations count toward LinkedIn's own weekly cap; a message to
    // someone you are already connected to does not.
    prisma.outreachMessage.count({
      where: {
        profileId,
        status: 'SENT',
        channel: 'CONNECTION_NOTE',
        sentAt: { gte: hoursAgo(24 * 7) },
      },
    }),
  ]);

  const { hourLimit, dayLimit, weeklyInviteLimit } = limits();

  let blockedReason: string | null = null;
  if (sentLastHour >= hourLimit) {
    blockedReason =
      `${sentLastHour} message(s) already went out in the last hour, and the cap is ${hourLimit}. ` +
      'Wait for the hour to roll over, or raise LINKEDIN_MAX_SENDS_PER_HOUR.';
  } else if (sentToday >= dayLimit) {
    blockedReason =
      `${sentToday} message(s) already went out in the last 24 hours, and the cap is ${dayLimit}. ` +
      'Wait, or raise LINKEDIN_MAX_SENDS_PER_DAY.';
  } else if (invitesThisWeek >= weeklyInviteLimit) {
    blockedReason =
      `${invitesThisWeek} connection invitations have gone out in the last 7 days, and the cap is ` +
      `${weeklyInviteLimit}. LinkedIn restricts accounts that push past its own weekly limit, so ` +
      'this one stops short of it. Messages to existing connections are unaffected.';
  }

  return {
    sentLastHour,
    sentToday,
    invitesThisWeek,
    hourLimit,
    dayLimit,
    weeklyInviteLimit,
    blockedReason,
  };
}

function limits() {
  return {
    hourLimit: config.linkedinMaxSendsPerHour,
    dayLimit: config.linkedinMaxSendsPerDay,
    weeklyInviteLimit: config.linkedinWeeklyInviteLimit,
  };
}

/**
 * Refuse the send, or return quietly.
 *
 * The weekly invitation cap only blocks invitations, so the channel has to be
 * known here rather than checked generically.
 */
export async function assertWithinQuota(
  profileId: string,
  channel: 'CONNECTION_NOTE' | 'DIRECT_MESSAGE' | 'INMAIL',
): Promise<void> {
  const quota = await outreachQuota(profileId);
  if (!quota.blockedReason) return;
  const weeklyOnly =
    quota.sentLastHour < quota.hourLimit && quota.sentToday < quota.dayLimit;
  if (weeklyOnly && channel !== 'CONNECTION_NOTE') return;
  throw new QuotaExceededError(quota.blockedReason);
}
