import { citiesIn, countryByCode, locatedIn } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { isSeniorLevel, requiresMoreThan5YearsExperience } from './jobFilters.js';
import { API_SOURCES } from './sources/index.js';
import { companyDirectory, type CompanyFacts } from './topCompanies.js';

/**
 * Which leads are on screen, in what order, one page at a time.
 *
 * Several filters and sorts need more than SQL - "in this country" reads the
 * location the way intake does, pay comes from the target-company list, the
 * recommended order blends three signals - so the matching set (a few thousand
 * short rows at most) is read once, filtered and ranked here, and only then is
 * the page cut. Filtering after cutting, as this used to, returned pages of 9
 * under a header promising 25.
 */

export type LeadSort = 'recommended' | 'score' | 'pay' | 'posted' | 'discovered';

export interface LeadListQuery {
  status: string;
  page: number;
  limit: number;
  sort: LeadSort;
  /** Title, company, location or anything in the description (skills live there). */
  q: string;
  remote: 'any' | 'yes' | 'no';
  minScore?: number;
  depth: 'any' | 'deep' | 'quick';
  /** Only postings dated within this many days. Undated ones are left out, not assumed fresh. */
  postedWithin?: number;
  /** ISO-2: located in this country, or remote and open to it. */
  country?: string;
  /** Canonical city name from CITIES. */
  city?: string;
  company?: string;
  /** Target-list tier: quant, bigtech, infra-saas, india-product, finance-gcc. */
  tier?: string;
  /** Minimum company SDE2 pay ceiling, in LPA. */
  minPay?: number;
  /** Only boards the app can fill in by itself. */
  autoApply: boolean;
  excludeSenior: boolean;
}

/** The boards the app has form adapters for. */
const AUTO_APPLY = new Set(API_SOURCES.map((s) => s.id));

/** The pay ceiling that earns full weight in the recommended order. */
const PAY_FOR_FULL_WEIGHT = 150;

/**
 * The recommended order: match first, then pay, then freshness.
 *
 * Multiplicative so a poor match stays low however well the company pays.
 * Unknown pay and undated postings get a middle weight - not rewarded, not
 * punished for what the source did not say.
 */
export function recommendedRank(score: number, facts: CompanyFacts | undefined, postedAt: Date | null, now = Date.now()): number {
  const pay = facts ? Math.min(facts.payCeiling, PAY_FOR_FULL_WEIGHT) / PAY_FOR_FULL_WEIGHT : 0;
  const days = postedAt ? (now - postedAt.getTime()) / 86_400_000 : null;
  const fresh = days === null ? 0.85 : days <= 14 ? 1 : days <= 30 ? 0.9 : days <= 60 ? 0.8 : 0.7;
  return score * (0.7 + 0.3 * pay) * fresh;
}

export async function listLeads(profileId: string, query: LeadListQuery) {
  // ---- the SQL-expressible part ---------------------------------------------
  const tab: Prisma.JobLeadWhereInput = { profileId };
  if (query.status !== 'ALL') tab.status = query.status as Prisma.JobLeadWhereInput['status'];

  const where: Prisma.JobLeadWhereInput = { ...tab };
  if (query.remote !== 'any') where.remote = query.remote === 'yes';
  if (query.minScore !== undefined) where.score = { gte: query.minScore };
  if (query.depth !== 'any') where.deepScored = query.depth === 'deep';
  if (query.company) where.companyName = query.company;
  if (query.postedWithin) where.postedAt = { gte: new Date(Date.now() - query.postedWithin * 86_400_000) };
  if (query.autoApply) where.ats = { in: [...AUTO_APPLY] };
  if (query.q) {
    where.OR = (['title', 'companyName', 'location', 'descriptionText'] as const).map((f) => ({
      [f]: { contains: query.q, mode: 'insensitive' },
    }));
  }

  const rows = await prisma.jobLead.findMany({
    where,
    orderBy: [{ score: 'desc' }, { discoveredAt: 'desc' }, { id: 'asc' }],
    select: {
      id: true, title: true, companyName: true, location: true, remote: true, score: true,
      postedAt: true, discoveredAt: true, descriptionText: query.excludeSenior,
    },
  });

  // ---- the rest ----------------------------------------------------------------
  const directory = companyDirectory();
  const facts = (name: string) => directory.get(name.toLowerCase());
  const country = countryByCode(query.country);

  const kept = rows.filter((r) => {
    const f = facts(r.companyName);
    if (country && !locatedIn(r.location, r.remote, country)) return false;
    if (query.city && !citiesIn(r.location).includes(query.city)) return false;
    if (query.tier && f?.tier !== query.tier) return false;
    if (query.minPay && (f?.payCeiling ?? 0) < query.minPay) return false;
    if (query.excludeSenior && (isSeniorLevel(r.title) || requiresMoreThan5YearsExperience(r.descriptionText))) return false;
    return true;
  });

  // Array.sort is stable, so ties keep the SQL order: best score, newest found.
  const time = (d: Date | null) => d?.getTime() ?? -Infinity;
  const rank: Record<LeadSort, (a: (typeof kept)[number], b: (typeof kept)[number]) => number> = {
    recommended: (a, b) =>
      recommendedRank(b.score, facts(b.companyName), b.postedAt) - recommendedRank(a.score, facts(a.companyName), a.postedAt),
    score: () => 0,
    pay: (a, b) => (facts(b.companyName)?.payCeiling ?? 0) - (facts(a.companyName)?.payCeiling ?? 0),
    posted: (a, b) => time(b.postedAt) - time(a.postedAt),
    discovered: (a, b) => time(b.discoveredAt) - time(a.discoveredAt),
  };
  kept.sort(rank[query.sort]);

  // Clamp rather than 404: deciding on the last lead of the last page would
  // otherwise land you on an empty one, which reads as "everything is gone".
  const total = kept.length;
  const pages = Math.max(1, Math.ceil(total / query.limit));
  const page = Math.min(query.page, pages);
  const pageIds = kept.slice((page - 1) * query.limit, page * query.limit).map((r) => r.id);
  const leads = (await prisma.jobLead.findMany({ where: { id: { in: pageIds } } })).sort(
    (a, b) => pageIds.indexOf(a.id) - pageIds.indexOf(b.id),
  );

  // ---- counts --------------------------------------------------------------------
  // Facets count the tab as a whole, so a choice never shows zero just because
  // another filter is on.
  const [counts, strong, inTab] = await Promise.all([
    prisma.jobLead.groupBy({ by: ['status'], where: { profileId }, _count: true }),
    prisma.jobLead.count({ where: { profileId, status: 'NEW', score: { gte: 70 } } }),
    prisma.jobLead.findMany({ where: tab, select: { companyName: true, location: true } }),
  ]);
  const tally = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  return {
    // The description is large and the list view never shows it in full.
    leads: leads.map((l) => {
      const f = facts(l.companyName);
      return { ...l, descriptionText: l.descriptionText?.slice(0, 600) ?? null, payCeiling: f?.payCeiling ?? null, tier: f?.tier ?? null, autoApply: AUTO_APPLY.has(l.ats) };
    }),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    facets: {
      companies: tally(inTab.map((r) => r.companyName)),
      cities: tally(inTab.flatMap((r) => citiesIn(r.location))),
      tiers: tally(inTab.flatMap((r) => facts(r.companyName)?.tier ?? [])),
    },
    total,
    page,
    pages,
    limit: query.limit,
    strong,
  };
}
