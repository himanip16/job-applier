/**
 * Crawlers for the companies that do not use Greenhouse, Lever or Ashby.
 *
 * Most of the best-paying employers run their own careers site, and a generic
 * page crawl does badly on them: they are client-rendered, paginated behind
 * JavaScript, and list thousands of roles worldwide. Almost all of them are
 * backed by a JSON endpoint the page itself calls, though, and reading that is
 * the same trade the board APIs make - structured data, real locations, full
 * descriptions, no DOM parsing.
 *
 * Workday, SmartRecruiters, Eightfold, Jobvite, Jibe and Radancy are platforms many
 * companies share, so their handle names the tenant. Google, Apple, Amazon,
 * LinkedIn and Atlassian are one company's own site. Each lives in its own file and
 * shares the paging, hydration and dedupe logic in shared.ts.
 *
 * Every source searches server-side with the caller's role titles and country
 * where the site supports it, and caps how many postings it reads, because
 * "read all 1,700 NVIDIA openings to keep eight" is not a crawl, it is a load
 * test on someone else's website.
 */
import type { Source } from '../types.js';
import { amazonSource } from './amazon.js';
import { appleSource } from './apple.js';
import { atlassianSource } from './atlassian.js';
import { eightfoldSource } from './eightfold.js';
import { googleSource } from './google.js';
import { jibeSource } from './jibe.js';
import { jobviteSource } from './jobvite.js';
import { linkedinCompanySource } from './linkedin.js';
import { radancySource } from './radancy.js';
import { ripplingSource } from './rippling.js';
import { smartRecruitersSource } from './smartRecruiters.js';
import { workdaySource } from './workday.js';

/** Platforms many companies share: offered when adding a company by hand. */
export const SHARED_PLATFORM_SOURCES: Source[] = [workdaySource, smartRecruitersSource, eightfoldSource, jobviteSource];

export const CAREER_SITE_SOURCES: Source[] = [
  ...SHARED_PLATFORM_SOURCES,
  jibeSource,
  radancySource,
  ripplingSource,
  googleSource,
  appleSource,
  amazonSource,
  linkedinCompanySource,
  atlassianSource,
];
