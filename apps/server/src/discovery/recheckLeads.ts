import type { Country } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { canonicalUrl } from './jobSearchUtils.js';
import { screen } from './leadIntake.js';
import { eachLimited, postingStatus } from './postingStatus.js';
import { API_SOURCES, sourceById, type DiscoveredJob } from './sources/index.js';

/**
 * Go back over the jobs already waiting in the queue and drop the ones that
 * should not be there any more.
 *
 * A lead is checked against the same intake rules a new posting meets (so a
 * rule added later reaches old leads too), plus one only time can break: on
 * the boards that list every opening, a posting that has disappeared has
 * closed. Every other lead - careers sites, web search, a board that could
 * not be read - is opened one by one and dropped if the posting itself says it
 * has gone (see postingStatus.ts). The intake rules only touch undecided
 * leads - shortlisted, applied and rejected ones are your decisions, and the
 * rejections are what stop a job coming back. A closed posting is removed from
 * Saved too: there is nothing left there to apply to. Applied cards and ones
 * with a run attached stay.
 */

export interface RecheckReport {
  checked: number;
  removed: number;
  removedBy: { tooOld: number; wrongDomain: number; tooSenior: number; otherCountry: number; closed: number };
  /** Boards that could not be read; their leads were checked one by one instead. */
  unreachable: string[];
  /** Leads whose page gave no clear answer (a client-rendered shell, a block, a timeout), so they were kept. */
  unknown: number;
}

/** Posting pages read at once; enough to finish in a minute or two, few enough not to look like a scrape. */
const PAGE_CHECKS_AT_ONCE = 4;

/** Only these list every open posting, so absence from them means closed. */
const COMPLETE_BOARDS = new Set(API_SOURCES.map((s) => s.id));

export async function recheckLeads(profileId: string, opts: { country?: Country } = {}): Promise<RecheckReport> {
  const leads = await prisma.jobLead.findMany({
    where: { profileId, OR: [{ status: 'NEW' }, { status: 'SHORTLISTED', applicationId: null }] },
    select: {
      id: true, status: true, url: true, ats: true, title: true, companyName: true, location: true, remote: true,
      descriptionText: true, postedAt: true, company: { select: { id: true, name: true, source: true, handle: true } },
    },
  });

  const report: RecheckReport = {
    checked: leads.length,
    removed: 0,
    removedBy: { tooOld: 0, wrongDomain: 0, tooSenior: 0, otherCountry: 0, closed: 0 },
    unreachable: [],
    unknown: 0,
  };
  const doomed: string[] = [];
  const survivors: typeof leads = [];

  // ---- 1. the intake rules --------------------------------------------------
  for (const lead of leads) {
    if (lead.status !== 'NEW') {
      survivors.push(lead);
      continue;
    }
    const job: DiscoveredJob = {
      ...lead,
      location: lead.location ?? undefined,
      descriptionText: lead.descriptionText ?? '',
      postedAt: lead.postedAt ?? undefined,
    };
    const rejection = screen(job, { country: opts.country });
    if (rejection === 'tooOld' || rejection === 'wrongDomain' || rejection === 'tooSenior' || rejection === 'otherCountry') {
      report.removedBy[rejection]++;
      doomed.push(lead.id);
    } else {
      survivors.push(lead);
    }
  }

  // ---- 2. still open? -------------------------------------------------------
  const byCompany = new Map<string, typeof leads>();
  // Not on a board that lists everything, so only the posting can say.
  const onePage: typeof leads = [];
  for (const lead of survivors) {
    if (!lead.company || !COMPLETE_BOARDS.has(lead.company.source)) onePage.push(lead);
    else byCompany.set(lead.company.id, [...(byCompany.get(lead.company.id) ?? []), lead]);
  }
  for (const group of byCompany.values()) {
    const company = group[0]!.company!;
    let open: Set<string>;
    try {
      const jobs = await sourceById(company.source)!.fetchJobs(company.handle);
      open = new Set(jobs.map((j) => canonicalUrl(j.url)));
    } catch {
      report.unreachable.push(company.name);
      onePage.push(...group);
      continue;
    }
    // An empty answer is more likely a renamed or private board than a
    // company that closed every role at once; do not empty the queue on it.
    if (!open.size) {
      report.unreachable.push(company.name);
      onePage.push(...group);
      continue;
    }
    for (const lead of group) {
      if (!open.has(canonicalUrl(lead.url))) {
        report.removedBy.closed++;
        doomed.push(lead.id);
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  await eachLimited(onePage, PAGE_CHECKS_AT_ONCE, async (lead) => {
    const status = await postingStatus(lead.url);
    if (status === 'closed') {
      report.removedBy.closed++;
      doomed.push(lead.id);
    } else if (status === 'unknown') {
      report.unknown++;
    }
  });

  if (doomed.length) {
    const result = await prisma.jobLead.deleteMany({
      where: { id: { in: doomed }, profileId, OR: [{ status: 'NEW' }, { status: 'SHORTLISTED', applicationId: null }] },
    });
    report.removed = result.count;
  }
  return report;
}
