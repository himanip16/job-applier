import type { Page } from 'playwright';
import { secret } from '../lib/secrets.js';
import type { Blocker } from '../browser/blockers.js';
import { signInWithSavedAccount, signInWithSavedMicrosoftAccount } from './authHandlers.js';

/**
 * Parked on Microsoft Careers' sign-in with no Microsoft password saved: once
 * one is, sign in with it and carry on. Never resolves if that sign-in does not
 * get through - the person finishes it in the browser, and watchForClearance
 * sees it.
 */
export function signInToMicrosoftOnceSaved(
  applicationId: string,
  page: Page,
  stopped: AbortSignal,
): Promise<{ carryOn: boolean; note?: string }> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (stopped.aborted || !secret('MICROSOFT_ACCOUNT_PASSWORD')) return;
      clearInterval(timer);
      void signInWithSavedMicrosoftAccount(applicationId, page).then((ok) => {
        if (ok && !stopped.aborted) resolve({ carryOn: true });
      });
    }, 1500);
    stopped.addEventListener('abort', () => clearInterval(timer));
  });
}

/**
 * Waiting on the password popup: once a password is saved, sign in with it and
 * carry on without anyone pressing Continue. Never resolves if that sign-in
 * fails - the person finishes it in the browser, and watchForClearance sees it.
 */
export function signInOnceSaved(
  applicationId: string,
  page: Page,
  blocker: Blocker,
  stopped: AbortSignal,
): Promise<{ carryOn: boolean; note?: string }> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (stopped.aborted || !secret('JOB_SITE_PASSWORD')) return;
      clearInterval(timer);
      void signInWithSavedAccount(applicationId, page, blocker).then((ok) => {
        if (ok && !stopped.aborted) resolve({ carryOn: true });
      });
    }, 1500);
    stopped.addEventListener('abort', () => clearInterval(timer));
  });
}
