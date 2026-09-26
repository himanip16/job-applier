import type { Country } from '@ja/shared';

export interface DiscoveredJob {
  url: string;
  ats: string;
  title: string;
  companyName: string;
  location?: string;
  remote: boolean;
  descriptionText: string;
  postedAt?: Date;
}

/**
 * What the caller is looking for, for boards too big to read whole.
 *
 * NVIDIA or Google list thousands of openings worldwide; reading all of them
 * to keep the dozen that match is slow and impolite. The sources that can
 * search server-side use these; the small ATS boards ignore them and return
 * everything, which the caller filters anyway.
 */
export interface FetchHints {
  /** Role titles to search for, e.g. ["Software Engineer", "Backend Engineer"]. */
  queries?: string[];
  country?: Country;
}

export interface Source {
  id: string;
  /** Human-readable hint for what `handle` should be. */
  handleHint: string;
  fetchJobs(handle: string, hints?: FetchHints): Promise<DiscoveredJob[]>;
}
