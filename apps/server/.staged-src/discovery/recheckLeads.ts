import type { Country } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { canonicalUrl } from './jobSearchUtils.js';
import { screen } from './leadIntake.js';
import { API_SOURCES, sourceById, type DiscoveredJob } from './sources/index.js';

/**
 * Go back over the jobs already waiting in the queue and drop the ones that
 * should not be there any more.
 *
 * A lead is checked against the same intake rules a new posting meets (so a
 * rule added later reaches old leads too), plus one only time can break: on
 * the boards that list every opening, a posting that has disappeared has
 * closed. Only undecided leads are touched - shortlisted, applied and rejected
 * ones are your decisions, and the rejections are what stop a job coming back.
 */

export interface RecheckReport {
  checked: number;
  removed: number;
  removedBy: { tooOld: number; wrongDomain: number; tooSenior: number; otherCountry: number; closed: number };
  /** Boards that could not be read, so their leads were left alone. */
  unreachable: string[];
}

/** Only these list every open posting, so absence from them means closed. */
const COMPLETE_BOARDS = new Set(API_SOURCES.map((s) => s.id));

export async function recheckLeads(profileId: string, opts: { country?: Country } = {}): Promise<RecheckReport> {
  const leads = await prisma.jobLead.findMany({
    where: { profileId, status: 'NEW' },
    select: {
      id: true, url: true, ats: true, title: true, companyName: true, location: true, remote: true,
      descriptionText: true, postedAt: true, company: { select: { id: true, name: true, source: true, handle: true } },
    },
  });

  const report: RecheckReport = {
    checked: leads.length,
    removed: 0,
    removedBy: { tooOld: 0, wrongDomain: 0, tooSenior: 0, otherCountry: 0, closed: 0 },
    unreachable: [],
  };
  const doomed: string[] = [];
  const survivors: typeof leads = [];

  // ---- 1. the intake rules --------------------------------------------------
  for (const lead of leads) {
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
  for (const lead of survivors) {
    if (!lead.company || !COMPLETE_BOARDS.has(lead.company.source)) continue;
    byCompany.set(lead.company.id, [...(byCompany.get(lead.company.id) ?? []), lead]);
  }
  for (const group of byCompany.values()) {
    const company = group[0]!.company!;
    let open: Set<string>;
    try {
      const jobs = await sourceById(company.source)!.fetchJobs(company.handle);
      open = new Set(jobs.map((j) => canonicalUrl(j.url)));
    } catch {
      report.unreachable.push(company.name);
      continue;
    }
    // An empty answer is more likely a renamed or private board than a
    // company that closed every role at once; do not empty the queue on it.
    if (!open.size) {
      report.unreachable.push(company.name);
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

  if (doomed.length) {
    report.removed = (await prisma.jobLead.deleteMany({ where: { id: { in: doomed }, profileId, status: 'NEW' } })).count;
  }
  return report;
}
