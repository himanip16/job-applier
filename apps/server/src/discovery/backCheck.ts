import { prisma } from '../lib/db.js';
import { eachLimited, postingStatus } from './postingStatus.js';

/**
 * Check the jobs about to be shown are still open, so a closed posting is not
 * listed just because nobody pressed Clean up since it closed.
 *
 * Each posting is read at most once per CHECK_EVERY_MS (in memory, so a server
 * restart only means one more round of checks). The list waits up to
 * `budgetMs` for the answers; whatever is found closed by then is left out of
 * this response, and checks still running finish in the background and remove
 * their leads for the next load. Only undecided cards and Saved ones without a
 * run are removed - the same rule as recheckLeads.
 */

const CHECK_EVERY_MS = 6 * 3_600_000;
const CHECKS_AT_ONCE = 6;
const lastChecked = new Map<string, number>();

export async function backCheck(
  profileId: string,
  leads: Array<{ id: string; url: string }>,
  budgetMs = 2_500,
): Promise<Set<string>> {
  const now = Date.now();
  const due = leads.filter((l) => now - (lastChecked.get(l.url) ?? 0) > CHECK_EVERY_MS);
  const closed = new Set<string>();
  if (!due.length) return closed;
  for (const l of due) lastChecked.set(l.url, now);

  const all = eachLimited(due, CHECKS_AT_ONCE, async (lead) => {
    if ((await postingStatus(lead.url).catch(() => 'unknown' as const)) !== 'closed') return;
    const { count } = await prisma.jobLead.deleteMany({
      where: { id: lead.id, profileId, OR: [{ status: 'NEW' }, { status: 'SHORTLISTED', applicationId: null }] },
    });
    if (count) {
      closed.add(lead.id);
      console.log(`[backCheck] removed ${lead.url}: the posting has closed`);
    }
  }).catch(() => {});

  await Promise.race([all, new Promise((r) => setTimeout(r, budgetMs))]);
  // A snapshot: ids that close after this keep being removed in the background.
  return new Set(closed);
}
