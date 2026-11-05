import type { Page } from 'playwright';
import { bus } from '../lib/events.js';
import { detectBlockers, type Blocker } from '../browser/blockers.js';

/**
 * Notice when the human has dealt with it, without being told.
 *
 * "Press continue when you are done" is one more thing to remember, and the
 * app can just watch: the wall is either still on the page or it is not. Two
 * consecutive clear reads before believing it, because a page mid-navigation
 * briefly shows neither the wall nor the form.
 *
 * Never resolves while the wall is still up - the manual button is the other
 * half of the race and covers walls that cannot be detected as cleared.
 */
export function watchForClearance(
  applicationId: string,
  page: Page,
  blocker: Blocker,
): Promise<{ carryOn: boolean; note?: string }> {
  return new Promise((resolve) => {
    let clearReads = 0;
    let announced = false;

    // "Could not fill these fields" is not something detectBlockers can see,
    // so it always read as cleared and the run looped: fail every dropdown,
    // pause, "looks dealt with" four seconds later, fail them all again. Only
    // walls the page can show clear themselves; the rest wait for your click.
    //
    // A wall that brings its own test is the exception: "could not fill these
    // fields" is dealt with once you press the site's own Next and the step
    // changes, and waiting for a second click in this app after that left
    // finished pages sitting there.
    if (blocker.autoClears === false && !blocker.clearedWhen) return;

    const tick = async () => {
      if (page.isClosed()) return;
      try {
        const stillThere = blocker.clearedWhen
          ? !(await blocker.clearedWhen())
          : (await detectBlockers(page)).some((b) => b.kind === blocker.kind);
        clearReads = stillThere ? 0 : clearReads + 1;
        if (clearReads >= 2) {
          if (!announced) {
            announced = true;
            await bus
              .emitEvent(applicationId, 'LOG', 'That looks dealt with — carrying on by itself.')
              .catch(() => {});
            resolve({ carryOn: true });
          }
          return;
        }
      } catch {
        // Navigating, or the page went away. Try again on the next tick.
      }
      if (!announced) setTimeout(() => void tick(), 2000);
    };

    setTimeout(() => void tick(), 2000);
  });
}
