import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  /** Writing that goes out under your name: letters, essays, resume rewrites. */
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',
  /**
   * High-volume judgement calls: "is this answerable?", "does this job fit?".
   * These run many times per application and do not need the top model. Set it
   * to the same value as ANTHROPIC_MODEL to opt out of the split.
   */
  cheapModel: process.env.ANTHROPIC_MODEL_CHEAP ?? 'claude-haiku-4-5',

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
  maxSubmitsPerHour: num(process.env.MAX_SUBMITS_PER_HOUR, 10),
  answerConfidenceThreshold: num(process.env.ANSWER_CONFIDENCE_THRESHOLD, 0.82),
  memoryReuseThreshold: num(process.env.MEMORY_REUSE_THRESHOLD, 0.86),

  storageDir: rooted(process.env.STORAGE_DIR ?? './storage'),
  repoRoot: REPO_ROOT,
} as const;

export const artifactsDir = path.join(config.storageDir, 'artifacts');
export const resumesDir = path.join(config.storageDir, 'resumes');

export function assertLlmConfigured() {
  if (!config.anthropicApiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Cover letters and answer inference need it. ' +
        'Copy .env.example to .env and fill it in.',
    );
  }
}
