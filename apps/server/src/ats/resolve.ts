import { prisma } from '../lib/db.js';
import type { AtsAdapter } from './types.js';
import { greenhouseAdapter } from './adapters/greenhouse.js';

/**
 * A posting on a company's own domain whose application is a known ATS,
 * resolved from what we already know rather than by loading the page.
 *
 * stripe.com/jobs/search?gh_jid=N and rubrik.com/...?gh_jid=N are Greenhouse
 * postings - the id is Greenhouse's - found by crawling that company's
 * Greenhouse board. Greenhouse serves the bare application for any of them at
 * job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id> (checked live
 * for stripe and rubrik, 2026-09-27: both return `#application-form`), which
 * the Greenhouse adapter drives directly. Before this they went to the generic
 * adapter, which had to hope the careers page embedded an iframe in time.
 *
 * The board is the lead's own company row, never a guess from the domain.
 * Returns null when nothing is known, leaving the iframe sniff to try.
 */
export async function resolveKnownAts(
  url: string,
  profileId: string,
): Promise<{ url: string; adapter: AtsAdapter } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const token = parsed.searchParams.get('gh_jid');
  if (!token || !/^\d+$/.test(token) || /greenhouse\.io$/i.test(parsed.hostname)) return null;

  const lead = await prisma.jobLead.findFirst({
    where: { profileId, url },
    select: { company: { select: { source: true, handle: true } } },
  });
  const board = lead?.company?.source === 'greenhouse' ? lead.company.handle : null;
  if (!board) return null;

  const embed = new URL('https://job-boards.greenhouse.io/embed/job_app');
  embed.searchParams.set('for', board);
  embed.searchParams.set('token', token);
  return { url: embed.toString(), adapter: greenhouseAdapter };
}
