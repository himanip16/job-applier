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
  /** What people reported being paid at this company on LeetCode; null when nobody has. */
  pay?: { baseMedian: number | null; totalMedian: number | null; baseReports: number; totalReports: number } | null;
  /** Interview-experience posts naming the company on LeetCode in the last 90 days. */
  interviews90d?: number;
  /** The LeetCode posts behind those numbers. */
  leetcode?: { title: string; url: string; date: string; kind: 'pay' | 'interview' }[];
  tier?: string | null;
  /** What the description says about experience, verbatim; null when it says nothing. */
  experience?: { min: number; max?: number; quote: string } | null;
  /** Whether the app can fill this board's form by itself. */
  autoApply?: boolean;
}

/** A filter option with how many jobs in the current tab have it. */
export interface Facet {
  name: string;
  count: number;
}

export interface LeadPage {
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
  boards: { ats: string; slug: string; company: string; openings: number; kept: number; error?: string; warnings?: string[] }[];
  jobsSeen: number;
  jobsFetched?: number;
  newLeads: number;
  skippedAlreadySeen: number;
  skippedTooSenior?: number;
  skippedTooOld?: number;
  skippedOtherCountry?: number;
  /** Titles that matched none of the planned roles. */
  skippedOffPlan?: number;
  /** Sales, recruiting, legal and the like. */
  skippedWrongDomain?: number;
  /** A few of the titles behind each count, so an over-strict filter is visible. */
  droppedExamples?: { offPlan: string[]; wrongDomain: string[]; tooOld?: string[]; tooSenior?: string[]; otherCountry?: string[] };
  /** Kept postings that did not say where they are. */
  keptUnknownLocation?: number;
  /** Listed companies with no careers source set up, so not read. */
  noSource?: string[];
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
