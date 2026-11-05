import type { Page } from 'playwright';
import type { Blocker } from './blockerTypes.js';
import { detectCaptcha } from './captchaDetector.js';
import { detectAuthWalls, inlineAccountPending } from './authWallDetector.js';
import {
  detectSubmissionOutcome,
  confirmationShowing,
  submitWatchState,
} from './submissionDetector.js';

export type { Blocker };

/**
 * Detect the things that stop automated submission.
 *
 * This is the honest core of the system. A CAPTCHA is not a bug to be
 * engineered around - it is the site explicitly asking for a human, and both
 * Greenhouse and Lever ship one on their standard application forms
 * (reCAPTCHA and hCaptcha respectively). The design answer is to detect it,
 * stop, and hand the already-filled form to the person whose name is on it.
 * They spend five seconds instead of five minutes.
 *
 * Deliberately not implemented: solver services. They exist, they work, and
 * they are a straightforward violation of every one of these sites' terms.
 * Detection plus handoff keeps the whole flow defensible.
 */
export async function detectBlockers(page: Page): Promise<Blocker[]> {
  const found: Blocker[] = [];

  const captcha = await detectCaptcha(page);
  if (captcha) {
    found.push(captcha);
  }

  const authWalls = await detectAuthWalls(page);
  found.push(...authWalls);

  return found;
}

// Re-export from modules for backward compatibility
export { inlineAccountPending };
export { detectSubmissionOutcome, confirmationShowing, submitWatchState };
