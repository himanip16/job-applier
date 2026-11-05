import type { Page } from 'playwright';
import { bus } from '../lib/events.js';
import { config } from '../lib/config.js';
import type { Blocker } from '../browser/blockers.js';

/**
 * Get in front of the person.
 *
 * A run that parks silently is a run that sits there until someone happens to
 * look at it. The action needed is almost always *in the browser window that
 * is already open* - sign in, solve this - so the most useful nudge is to put
 * that window in front of them. The terminal bell covers the case where the
 * browser is on another desktop, and the UI raises its own notification from
 * the status.
 */
export async function nudge(applicationId: string, page: Page, blocker: Blocker): Promise<void> {
  if (!config.headless) {
    // Best-effort: a window manager may refuse, and that is not worth failing
    // a run over.
    await page.bringToFront().catch(() => {});
  }
  // \x07 is the terminal bell. One character, and it is the difference between
  // noticing in five seconds and noticing in five minutes.
  process.stdout.write(`\x07[needs you] ${blocker.kind}: ${blocker.detail}\n`);
  await bus.emitEvent(
    applicationId,
    'NEEDS_YOU',
    !blocker.humanCanClear
      ? 'Waiting for you.'
      : blocker.autoClears === false && !blocker.clearedWhen
        ? 'Waiting for you in the browser window. Press Continue here once it is dealt with.'
        : blocker.clearedWhen
          ? 'Waiting for you in the browser window. Fill those in, then press Continue here - or the ' +
            "site's own Next button, and it picks up on the next step."
          : 'Waiting for you in the browser window. It carries on by itself once the page is past this.',
    { kind: blocker.kind },
  );
}
