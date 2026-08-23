import type { Page } from 'playwright';

/**
 * Recover from transient navigations that tear down the execution context while
 * a page.evaluate() is in flight.
 *
 * This is common on ATS pages that click through an Apply flow and then
 * immediately replace the document. The retry waits for the browser to settle
 * before re-running the DOM probe instead of crashing the whole run.
 */
export async function evaluatePage<T>(page: Page, fn: () => T): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(fn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/Execution context was destroyed|Target page, context or browser has been closed/i.test(message) || attempt === 2) {
        throw err;
      }

      lastError = err;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(250);
    }
  }

  throw lastError ?? new Error('Page evaluation failed unexpectedly.');
}
