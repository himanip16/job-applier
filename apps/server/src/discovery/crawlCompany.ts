import { newPage } from '../browser/session.js';
import {
  crawlCareersPage,
  sourceById,
  type DiscoveredJob,
} from './sources.js';

/**
 * Crawl a single company, deciding whether to use careers-page or an ATS source.
 * 
 * Handles:
 * - Source selection (careers-page vs ATS)
 * - Browser page creation/reuse
 * - Job fetching
 * - Company name normalization
 * - Error handling
 * 
 * Returns the jobs, the potentially-created page for reuse, and any error that occurred.
 */
export async function crawlCompany(
  company: { name: string; source: string; handle: string },
  page: Awaited<ReturnType<typeof newPage>> | null,
): Promise<{ jobs: DiscoveredJob[]; page: Awaited<ReturnType<typeof newPage>> | null; error?: string }> {
  let jobs: DiscoveredJob[] = [];
  let currentPage = page;
  
  try {
    if (company.source === 'careers-page') {
      currentPage ??= await newPage();
      jobs = await crawlCareersPage(currentPage, company.handle);
    } else {
      const source = sourceById(company.source);
      if (!source) throw new Error(`Unknown source "${company.source}"`);
      jobs = await source.fetchJobs(company.handle);
    }
    
    // The board APIs return the slug, not the display name.
    jobs = jobs.map((j) => ({ ...j, companyName: company.name || j.companyName }));
    
    return { jobs, page: currentPage };
  } catch (err) {
    return { jobs: [], page: currentPage, error: (err as Error).message };
  }
}
