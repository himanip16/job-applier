import type { Page } from 'playwright';
import { getContextSync } from '../../src/browser/session.js';

/**
 * The page the run is currently sitting on.
 *
 * Tests that exercise the human-in-the-loop path need to do what a person
 * would do — click "Sign In" in the window that is already open — and the run
 * deliberately keeps that page alive while it is parked.
 *
 * Matched by URL rather than by taking the last one: a persistent context
 * opens with a blank page of its own, and previous tests in the file leave
 * their pages behind.
 */
export function activePageFor(match: string): Page {
  const ctx = getContextSync();
  if (!ctx) throw new Error('No browser context; the run has not opened a page yet.');
  const pages = ctx.pages();
  const page = [...pages].reverse().find((p) => p.url().includes(match));
  if (!page) {
    throw new Error(
      `No open page matching "${match}". Open pages: ${pages.map((p) => p.url()).join(', ') || '(none)'}`,
    );
  }
  return page;
}
