import type { Page } from 'playwright';
import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { screenshot } from '../browser/session.js';
import { submitWatchState } from '../browser/blockers.js';
import { artifact } from './runLog.js';
import { markLeadApplied } from './leadSync.js';

/**
 * You pressed submit yourself, in a tab the app had open.
 *
 * That happens at the review gate, at a wall you were sent to the browser
 * for, and in tabs a finished run left open (set aside, unconfirmed, failed).
 * Coming back to the app to say "it went through" is one more thing to
 * remember, so the tab is watched instead.
 *
 * Only the site's own confirmation counts, and only once it appears: the
 * first read must not already show one, so a page that happens to say
 * "application received" somewhere is never taken as your submit. Apple's
 * Review & Submit is the exception: its Submit goes to your profile without
 * saying so, and that move is the confirmation (see submitWatchState).
 */
const POLL_MS = 3000;

/**
 * Resolve with the confirmation text once it appears on this page. Never
 * resolves if the page closes or `signal` fires first.
 */
export function watchForManualSubmit(page: Page, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    let baseline: boolean | null = null;
    let wasOnAppleReview = false;
    const tick = async () => {
      if (signal?.aborted || page.isClosed()) return;
      try {
        const { confirmed, appleStep, appleLanding } = await submitWatchState(page);
        if (wasOnAppleReview && appleLanding) return resolve(appleLanding);
        if (appleStep !== 'between') wasOnAppleReview = appleStep === 'review';
        if (baseline === null) baseline = !!confirmed;
        else if (confirmed && !baseline) return resolve(confirmed);
        else if (!confirmed) baseline = false;
      } catch {
        // Navigating, or the page went away. Try again on the next tick.
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
  });
}

/** Record a submit the app saw you make. */
export async function recordManualSubmit(applicationId: string, page: Page, detail: string): Promise<void> {
  await artifact(applicationId, 'screenshot', 'after-submit', await screenshot(page, applicationId, 'after-submit')).catch(
    () => {},
  );
  await prisma.application.update({
    where: { id: applicationId },
    data: { status: 'SUBMITTED', submittedAt: new Date(), confirmation: detail, blockedReason: null },
  });
  await bus.emitEvent(applicationId, 'STATUS', 'You submitted it in the browser - the site confirmed it.', {
    status: 'SUBMITTED',
    manual: true,
  });
  await markLeadApplied(applicationId);
}

/**
 * Watch a tab a finished run left open. Stops when the tab closes (a new run
 * closes the old tab first) or when the application is already settled.
 */
export function watchLeftOpenTab(applicationId: string, page: Page): void {
  void watchForManualSubmit(page).then(async (detail) => {
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { status: true } });
    if (!app || app.status === 'SUBMITTED') return;
    await recordManualSubmit(applicationId, page, detail);
  }).catch(() => {});
}
