export interface Lead {
  id: string;
  url: string;
  ats: string;
  title: string;
  companyName: string;
  location: string | null;
  postedAt?: string | null;
  discoveredAt?: string | null;
  remote: boolean;
  descriptionText: string | null;
  score: number;
  deepScored: boolean;
  scoreReasons: {
    verdict?: string;
    seniorityFit?: string;
    forIt?: string[];
    againstIt?: string[];
    dealbreaker?: string;
    likedTerms?: string[];
    dislikedTerms?: string[];
    affinity?: number;
    sharedTerms?: string[];
    missingTerms?: string[];
  } | null;
  status: string;
  /** Company SDE2 pay ceiling in LPA, from the target list; null when unknown. */
  payCeiling?: number | null;
  tier?: string | null;
  /** Whether the app can fill this board's form by itself. */
  autoApply?: boolean;
}

/** A filter option with how many jobs in the current tab have it. */
export export interface Facet {
  name: string;
  count: number;
}

export export interface LeadPage {
  leads: Lead[];
  counts: Record<string, number>;
  facets: { companies: Facet[]; cities: Facet[]; tiers: Facet[] };
  total: number;
  page: number;
  pages: number;
  limit: number;
  strong: number;
  maxRescoreBatch: number;
}

export interface RescoreResult {
  id: string;
  ok: boolean;
  score?: number;
  error?: string;
}

export interface SearchReport {
  planSource: 'model' | 'profile';
  roleTitles: string[];
  queries: { query: string; hits: number }[];
  creditsUsed: number;
  boards: { ats: string; slug: string; company: string; openings: number; kept: number; error?: string }[];
  jobsSeen: number;
  newLeads: number;
  skippedAlreadySeen: number;
  skippedTooOld?: number;
  skippedOtherCountry?: number;
  deepScored: number;
  companiesRegistered: number;
  rerankedExisting: number;
  notes: string[];
  errors: { where: string; error: string }[];
}

export interface Company {
  id: string;
  name: string;
  source: string;
  handle: string;
  lastCrawledAt: string | null;
  lastCrawlNote: string | null;
}
