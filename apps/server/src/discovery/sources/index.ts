/**
 * Where job leads come from.
 *
 * Three kinds of source, each in its own folder or file:
 *
 *  - boards/: the ATS boards' own public, unauthenticated postings APIs
 *    (Greenhouse, Lever, Ashby, Workable). The platforms want aggregators to
 *    read them, so this is sanctioned and far more reliable than parsing a
 *    rendered page: structured JSON, full descriptions, stable ids.
 *  - careerSites/: the JSON endpoints behind big companies' own careers sites
 *    (Workday, Eightfold, Google, Apple, ...), searched server-side.
 *  - careersPage.ts: a real browser crawl, for companies with nothing better.
 *    Best-effort and depth-limited.
 *
 * Everything a source returns is a DiscoveredJob, so the rest of discovery
 * never needs to know which kind found it.
 */
import { ashbySource } from './boards/ashby.js';
import { greenhouseSource } from './boards/greenhouse.js';
import { leverSource } from './boards/lever.js';
import { workableSource } from './boards/workable.js';
import { CAREER_SITE_SOURCES } from './careerSites/index.js';
import type { Source } from './types.js';

export type { DiscoveredJob, FetchHints, Source } from './types.js';
export { crawlCareersPage } from './careersPage.js';
export { ashbySource, greenhouseSource, leverSource, workableSource };
export { SHARED_PLATFORM_SOURCES } from './careerSites/index.js';

/** The ATS boards, which are also the ones the app can apply on. */
export const API_SOURCES: Source[] = [greenhouseSource, leverSource, ashbySource, workableSource];

const ALL_SOURCES: Source[] = [...API_SOURCES, ...CAREER_SITE_SOURCES];

export const sourceById = (id: string): Source | undefined => ALL_SOURCES.find((s) => s.id === id);
