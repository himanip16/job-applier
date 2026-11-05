import { recommendedRank } from './leadListing.js';

/**
 * How many undecided jobs one company may have waiting in "For you".
 *
 * A big company posts dozens of near-identical roles and buried everyone
 * else; past the first few you are not going to apply to more of theirs
 * anyway. Override with MAX_LEADS_PER_COMPANY.
 */
export const MAX_LEADS_PER_COMPANY = Math.max(1, Number(process.env.MAX_LEADS_PER_COMPANY) || 3);

export interface CappableLead {
  id: string;
  companyName: string;
  score: number;
  postedAt: Date | null;
  discoveredAt: Date;
}

/**
 * Split leads into the best MAX per company and the rest.
 *
 * "Best" is match blended with freshness (the same weighting as the
 * Recommended sort, minus pay, which is the same for every job at one
 * company), then newest first on a tie.
 */
export function capPerCompany<T extends CappableLead>(leads: T[], max = MAX_LEADS_PER_COMPANY): { kept: T[]; extra: T[] } {
  const groups = new Map<string, T[]>();
  for (const lead of leads) {
    const key = lead.companyName.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), lead]);
  }
  const now = Date.now();
  const time = (d: Date | null) => d?.getTime() ?? 0;
  const kept: T[] = [];
  const extra: T[] = [];
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        recommendedRank(b.score, undefined, b.postedAt, now) - recommendedRank(a.score, undefined, a.postedAt, now) ||
        time(b.postedAt ?? b.discoveredAt) - time(a.postedAt ?? a.discoveredAt),
    );
    kept.push(...group.slice(0, max));
    extra.push(...group.slice(max));
  }
  return { kept, extra };
}
