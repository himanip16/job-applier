import { prisma } from '../lib/db.js';
import type { AtsAdapter } from './types.js';
import { greenhouseAdapter } from './adapters/greenhouse.js';
import { workdayAdapter } from './adapters/workday.js';
import { postJson } from '../discovery/sources/http.js';

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
  if (!token || !/^\d+$/.test(token) || /greenhouse\.io$/i.test(parsed.hostname)) {
    return resolveWorkdayReq(parsed, url, profileId);
  }

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

/**
 * A company careers site in front of Workday, e.g.
 * careers.adobe.com/us/en/job/R170239/Computer-Scientist-2 (Phenom). The
 * application is on adobe.wd5.myworkdayjobs.com, and the R-number in the path
 * is Workday's requisition id: the board's search finds the posting by it
 * (checked live for Adobe's R169338, 2026-10-15). The Workday adapter then
 * drives `<posting>/apply` as for any discovered Workday job.
 *
 * The board is the lead's company row when it is a Workday one, else the
 * Workday company whose tenant is the site's domain name ("adobe" for
 * careers.adobe.com). Returns null when there is no such board, or the
 * posting is not on it (closed).
 */
async function resolveWorkdayReq(
  parsed: URL,
  url: string,
  profileId: string,
): Promise<{ url: string; adapter: AtsAdapter } | null> {
  const req = parsed.pathname.match(/\/(J?R-?\d{5,})(?:\/|$)/i)?.[1];
  if (!req || workdayAdapter.matches(url)) return null;

  const lead = await prisma.jobLead.findFirst({
    where: { profileId, url },
    select: { company: { select: { source: true, handle: true } } },
  });
  let handle = lead?.company?.source === 'workday' ? lead.company.handle : null;
  if (!handle) {
    const labels = parsed.hostname.toLowerCase().split('.');
    const name = labels[labels.length - 2];
    if (!name) return null;
    const company = await prisma.company.findFirst({
      where: { source: 'workday', handle: { startsWith: `${name}.wd` } },
      select: { handle: true },
    });
    handle = company?.handle ?? null;
  }
  const m = handle?.match(/^([a-z0-9-]+)\.(wd\d+)\/([A-Za-z0-9_-]+)$/i);
  if (!m) return null;
  const [, tenant, wd, site] = m as unknown as [string, string, string, string];
  const origin = `https://${tenant}.${wd}.myworkdayjobs.com`;

  const found = await postJson<{ jobPostings?: { externalPath: string; bulletFields?: string[] }[] }>(
    `${origin}/wday/cxs/${tenant}/${site}/jobs`,
    { appliedFacets: {}, limit: 5, offset: 0, searchText: req },
  ).catch(() => null);
  const posting = found?.jobPostings?.find(
    (p) => p.bulletFields?.some((b) => b.toUpperCase() === req.toUpperCase()) || p.externalPath.toUpperCase().endsWith(`_${req.toUpperCase()}`),
  );
  if (!posting) return null;
  return { url: `${origin}/${site}${posting.externalPath}`, adapter: workdayAdapter };
}
