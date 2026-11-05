import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secret } from './secrets.js';

/**
 * Repo root, derived from this file rather than from cwd.
 *
 * `pnpm --filter @ja/server ...` runs with cwd set to apps/server, while a
 * bare `node apps/server/src/index.ts` runs from the root. A cwd-relative
 * default would scatter resumes, screenshots and the browser profile across
 * two different directory trees depending on how you happened to start it.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Resolve a possibly-relative configured path against the repo root. */
const rooted = (p: string) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

const bool = (v: string | undefined, d: boolean) =>
  v === undefined ? d : /^(1|true|yes|on)$/i.test(v);
const num = (v: string | undefined, d: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  port: num(process.env.PORT, 8787),
  databaseUrl: process.env.DATABASE_URL ?? '',
  testDatabaseUrl: process.env.TEST_DATABASE_URL ?? '',

  /**
   * The four values below are getters, not constants.
   *
   * They are the ones you can change from the settings page, and a getter is
   * what lets a saved key take effect on the next request instead of the next
   * restart - without changing a single one of the ~15 call sites that read
   * `config.geminiApiKey` and friends.
   */

  /** 'anthropic' | 'gemini', or unset to infer from whichever key is present. */
  get llmProvider(): 'anthropic' | 'gemini' | undefined {
    return (secret('LLM_PROVIDER') as 'anthropic' | 'gemini' | undefined) || undefined;
  },

  get anthropicApiKey(): string {
    return secret('ANTHROPIC_API_KEY');
  },
  get geminiApiKey(): string {
    return secret('GEMINI_API_KEY', 'GOOGLE_API_KEY');
  },

  /**
   * Model slots, per provider.
   *
   * `*_MODEL` writes what goes out under your name and makes the
   * grounded-vs-unsupported call on resume keywords. `*_MODEL_CHEAP` handles
   * the high-volume judgement calls. Set both to the same value to opt out of
   * the split.
   *
   * Ids change - Gemini in particular has renamed and deprecated several
   * within a year - so these are configurable and GET /api/models reports what
   * your key can actually reach rather than trusting the defaults.
   */
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',
  anthropicModelCheap: process.env.ANTHROPIC_MODEL_CHEAP ?? 'claude-haiku-4-5',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash',
  geminiModelCheap: process.env.GEMINI_MODEL_CHEAP ?? 'gemini-3.5-flash',

  /**
   * Firecrawl, for finding openings without being told where to look.
   *
   * Optional. Without it the per-company crawler still works, you just have to
   * name the companies yourself.
   */
  get firecrawlApiKey(): string {
    return secret('FIRECRAWL_API_KEY');
  },
  firecrawlBaseUrl: (process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev').replace(/\/+$/, ''),
  /** Queries per search run. Each costs roughly two Firecrawl credits. */
  jobSearchQueries: num(process.env.JOB_SEARCH_QUERIES, 6),
  /** Results requested per query. */
  jobSearchResultsPerQuery: num(process.env.JOB_SEARCH_RESULTS_PER_QUERY, 10),

  headless: bool(process.env.HEADLESS, false),
  /**
   * Point at a Chromium you already have. Useful on images where Playwright's
   * own download is blocked or where a matching build is already on disk
   * (NixOS, locked-down corporate machines, CI containers).
   */
  chromiumExecutablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  browserProfileDir: rooted(process.env.BROWSER_PROFILE_DIR ?? '.playwright-profile'),
  actionDelayMs: num(process.env.ACTION_DELAY_MS, 120),

  requireReview: bool(process.env.REQUIRE_REVIEW, true),
  /** Enable auto-apply for high-scoring discovered jobs. */
  autoApplyEnabled: bool(process.env.AUTO_APPLY_ENABLED, false),
  /** Minimum score required for auto-apply (0-100). */
  autoApplyMinScore: num(process.env.AUTO_APPLY_MIN_SCORE, 70),
  /** Maximum number of jobs to auto-apply per scheduled run. */
  autoApplyMaxPerRun: num(process.env.AUTO_APPLY_MAX_PER_RUN, 5),
  /** Maximum number of retry attempts for failed applications. */
  maxApplicationRetries: num(process.env.MAX_APPLICATION_RETRIES, 3),
  /** Job posting expiry in days (leads older than this are marked expired). */
  jobExpiryDays: num(process.env.JOB_EXPIRY_DAYS, 30),
  /** Screenshots of each step. Off: nobody looked at them, and they are personal data on disk. */
  saveScreenshots: bool(process.env.SAVE_SCREENSHOTS, false),
  /**
   * How many screens of a wizard to walk before giving up.
   *
   * Workday's longest standard flow is six; twelve leaves room for a rejected
   * step being re-read and for tenants that split Voluntary Disclosures in
   * two. It exists to stop a loop, not to limit legitimate applications.
   */
  maxApplicationSteps: num(process.env.MAX_APPLICATION_STEPS, 12),
  maxSubmitsPerHour: num(process.env.MAX_SUBMITS_PER_HOUR, 10),
  /**
   * How long to wait between retries after a retryable model error, in ms.
   *
   * Sized for a free tier's per-minute window, which is the case worth waiting
   * out. Set to an empty string to disable retrying - reasonable on a paid
   * key, where a 429 usually means something else is wrong.
   */
  llmRetryDelaysMs: (process.env.LLM_RETRY_DELAYS_MS ?? '2000,6000,14000')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0),
  answerConfidenceThreshold: num(process.env.ANSWER_CONFIDENCE_THRESHOLD, 0.82),
  memoryReuseThreshold: num(process.env.MEMORY_REUSE_THRESHOLD, 0.86),

  /**
   * Application budget limits.
   *
   * Limits on the number of applications that can be submitted per time window.
   * Set to 0 or null to disable the limit for that window.
   */
  maxApplicationsPerDay: num(process.env.MAX_APPLICATIONS_PER_DAY, 20),
  maxApplicationsPerWeek: num(process.env.MAX_APPLICATIONS_PER_WEEK, 100),
  maxApplicationsPerMonth: num(process.env.MAX_APPLICATIONS_PER_MONTH, 300),

  /**
   * Location and work-mode validation.
   *
   * Whether to validate job location and work mode against profile preferences.
   */
  validateLocation: bool(process.env.VALIDATE_LOCATION, true),
  validateWorkMode: bool(process.env.VALIDATE_WORK_MODE, true),

  /**
   * Salary and experience validation.
   *
   * Whether to validate salary expectations and experience requirements.
   */
  validateSalary: bool(process.env.VALIDATE_SALARY, true),
  validateExperience: bool(process.env.VALIDATE_EXPERIENCE, true),

  /**
   * LLM cost tracking.
   *
   * Whether to track LLM token usage and estimated costs.
   */
  trackLLMCosts: bool(process.env.TRACK_LLM_COSTS, true),

  /**
   * Emergency kill switch.
   *
   * When enabled, prevents all new applications from being created or started.
   * Can be toggled via API endpoint or environment variable.
   */
  emergencyKillSwitchEnabled: bool(process.env.EMERGENCY_KILL_SWITCH_ENABLED, false),

  /**
   * Dry-run mode.
   *
   * When enabled, simulates applications without actually submitting them.
   * Useful for testing and validation.
   */
  dryRunMode: bool(process.env.DRY_RUN_MODE, false),

  /**
   * Require approval for uncertain answers.
   *
   * When enabled, requires explicit human approval for answers with confidence
   * below the threshold. This prevents the system from fabricating uncertain answers.
   */
  requireApprovalForUncertainAnswers: bool(process.env.REQUIRE_APPROVAL_FOR_UNCERTAIN_ANSWERS, true),
  uncertainAnswerThreshold: num(process.env.UNCERTAIN_ANSWER_THRESHOLD, 0.7),

  /**
   * LinkedIn outreach.
   *
   * The send caps sit deliberately under LinkedIn's own limits rather than at
   * them. LinkedIn restricts accounts that push its weekly invitation ceiling,
   * and the cost of that is losing the ability to connect with anyone by hand
   * for weeks - far worse than a slower queue. Raise them knowing that.
   */
  linkedinMaxSendsPerHour: num(process.env.LINKEDIN_MAX_SENDS_PER_HOUR, 5),
  linkedinMaxSendsPerDay: num(process.env.LINKEDIN_MAX_SENDS_PER_DAY, 15),
  /** LinkedIn's own ceiling is around 100 invitations a week. Stay under it. */
  linkedinWeeklyInviteLimit: num(process.env.LINKEDIN_WEEKLY_INVITE_LIMIT, 80),
  /** Result pages to read per search. Each is 25 postings. */
  linkedinJobPages: num(process.env.LINKEDIN_JOB_PAGES, 3),
  /** How many people to keep per company, per role. */
  linkedinContactsPerCompany: num(process.env.LINKEDIN_CONTACTS_PER_COMPANY, 3),
  /**
   * Pause between LinkedIn page loads, in ms. Slower than the form filler's
   * delay on purpose: this is someone else's site being read at volume, and
   * the rate is the single most visible difference between a person browsing
   * and a script scraping.
   */
  linkedinDelayMs: num(process.env.LINKEDIN_DELAY_MS, 1800),

  storageDir: rooted(process.env.STORAGE_DIR ?? './storage'),
  repoRoot: REPO_ROOT,
  /** Base URL for the web app (used for password reset links, etc.) */
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3001',

  /**
   * Distributed scheduler locking.
   *
   * Uses PostgreSQL advisory locks + database leases to ensure only one server instance
   * executes scheduled job discovery at a time.
   */
  /** Enable distributed locking for the scheduler (default: true) */
  schedulerLockEnabled: bool(process.env.SCHEDULER_LOCK_ENABLED, true),
  /** Lock acquisition timeout in milliseconds (default: 5 minutes) */
  schedulerLockTimeoutMs: num(process.env.SCHEDULER_LOCK_TIMEOUT_MS, 5 * 60 * 1000),
  /** Advisory lock key for the scheduler (default: 12345) */
  schedulerLockKey: num(process.env.SCHEDULER_LOCK_KEY, 12345),
  /** Lease duration in milliseconds (default: 30 minutes) */
  schedulerLeaseDurationMs: num(process.env.SCHEDULER_LEASE_DURATION_MS, 30 * 60 * 1000),
  /** Heartbeat interval in milliseconds (default: 5 minutes) */
  schedulerHeartbeatIntervalMs: num(process.env.SCHEDULER_HEARTBEAT_INTERVAL_MS, 5 * 60 * 1000),
} as const;

export const artifactsDir = path.join(config.storageDir, 'artifacts');
export const resumesDir = path.join(config.storageDir, 'resumes');

/** Which provider will actually be used, given the config. */
export function activeProvider(): 'anthropic' | 'gemini' {
  return config.llmProvider ?? (config.geminiApiKey ? 'gemini' : 'anthropic');
}
