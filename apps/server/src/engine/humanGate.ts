import type { Page } from 'playwright';
import type { AnswerGap, FormField, ResolvedAnswer } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { secret } from '../lib/secrets.js';
import { screenshot, unlessClosed } from '../browser/session.js';
import { detectBlockers, confirmationShowing, type Blocker } from '../browser/blockers.js';
import { park, blockerKey, abandon } from './waiters.js';
import { NeedsHumanError, NoFormError, describeDiagnosis } from '../browser/openForm.js';
import { setStatus, artifact } from './runLog.js';
import { whileWaitingOnHuman } from './slots.js';
import { onAppleSignIn } from '../browser/appleId.js';
import { onMicrosoftSignIn } from '../browser/microsoftAccount.js';
import { recordManualSubmit, watchForManualSubmit } from './manualSubmit.js';
import { postingGone, PostingGoneError } from './deadPosting.js';
import { SetAsideError, askHuman, isAutopilot } from './questionManager.js';
import {
  signInWithSavedAccount,
  signInWithSavedAppleId,
  signInWithSavedMicrosoftAccount,
  isAccountWall,
} from './authHandlers.js';
import { enterEmailedCode } from './emailVerification.js';
import { signInOnceSaved, signInToMicrosoftOnceSaved } from './pollingUtils.js';
import { watchForClearance } from './clearanceDetector.js';
import { nudge } from './userNotifier.js';

/**
 * Every point where the run needs a person.
 *
 * Three of them, and they share a shape: park on a promise, tell the human
 * what is wanted, and keep the browser page exactly as it is until they have
 * dealt with it. Re-driving forty dropdowns to get back to where you were is
 * slow and fragile, and any captcha token the page has earned is bound to that
 * page instance - so a run waits rather than restarts.
 *
 *  - a question it refuses to guess at            -> askHuman
 *  - a wall only a person can clear               -> pauseForHuman
 *  - the end of the road                          -> handOffToHuman
 */

export { SetAsideError, askHuman, isAutopilot };

export async function pauseForHuman(
  applicationId: string,
  page: Page,
  blocker: Blocker,
): Promise<boolean> {
  if (await signInWithSavedAppleId(applicationId, page, blocker)) return true;
  // Eightfold's modal has no email or password box of its own, so the job
  // site password has nothing to fill there; the Microsoft account does.
  const microsoft = isAccountWall(blocker) && (await onMicrosoftSignIn(page).catch(() => false));
  if (microsoft) {
    if (await signInWithSavedMicrosoftAccount(applicationId, page)) return true;
  } else if (await signInWithSavedAccount(applicationId, page, blocker)) return true;
  if (await enterEmailedCode(applicationId, page, blocker)) return true;
  // The app asks for the password in a popup; worth waiting for even on
  // autopilot, because every later account wall then clears by itself.
  const askingForPassword = isAccountWall(blocker) && !onAppleSignIn(page) && !microsoft && !secret('JOB_SITE_PASSWORD');
  if (askingForPassword) {
    await bus.emitEvent(
      applicationId,
      'LOG',
      'This site wants an account and no job site password is saved - asking you for one.',
    );
  }

  // Park BEFORE announcing, for the same reason as the review gate: a client
  // watching the run can see NEEDS_HUMAN and reply within microseconds, and a
  // reply that arrives before the promise exists is dropped forever.
  // Same for the Microsoft account: saving it in Settings finishes this run.
  const awaitingMicrosoft = microsoft && !secret('MICROSOFT_ACCOUNT_PASSWORD');

  if (!askingForPassword && !awaitingMicrosoft && (await isAutopilot(applicationId))) {
    await handOffToHuman(applicationId, page, blocker);
    throw new SetAsideError(
      'Autopilot: this needs you in the browser, so it is set aside with the tab left open. ' +
        'Start it again once that is dealt with. Moving on to the next job.',
      true,
    );
  }

  const key = blockerKey(applicationId);
  const manual = park<{ carryOn: boolean; note?: string }>(key);
  await handOffToHuman(applicationId, page, blocker);
  await nudge(applicationId, page, blocker);

  // Whichever comes first: you press the button, or the wall simply goes away
  // because you dealt with it. The second is the common case and it should not
  // require coming back to this app to say so.
  //
  // Or you finish the whole thing there and submit it yourself, which ends the run.
  let decision: { carryOn: boolean; note?: string; submitted?: string };
  const done = new AbortController();
  const waits: Array<Promise<typeof decision>> = [
    manual,
    watchForClearance(applicationId, page, blocker),
    watchForManualSubmit(page, done.signal).then((detail) => ({ carryOn: false, submitted: detail })),
  ];
  if (askingForPassword) waits.push(signInOnceSaved(applicationId, page, blocker, done.signal));
  if (awaitingMicrosoft) waits.push(signInToMicrosoftOnceSaved(applicationId, page, done.signal));
  try {
    decision = await whileWaitingOnHuman(
      applicationId,
      unlessClosed(page, Promise.race(waits), 'while waiting for you in the browser'),
    );
  } finally {
    done.abort();
    abandon(key);
  }

  // The wall "clearing" can win the race when what cleared it was your submit.
  // The page showed the wall, not a confirmation, when this pause began.
  if (decision.carryOn && !page.isClosed()) {
    const confirmed = await confirmationShowing(page).catch(() => null);
    if (confirmed) decision = { carryOn: false, submitted: confirmed };
  }
  if (decision.submitted) {
    await recordManualSubmit(applicationId, page, decision.submitted);
    return false;
  }
  if (!decision.carryOn) {
    await setStatus(applicationId, 'CANCELLED', decision.note ?? 'You cancelled this application.');
    return false;
  }
  await prisma.application.update({
    where: { id: applicationId },
    data: { blockedReason: null },
  });
  await bus.emitEvent(applicationId, 'LOG', 'Carrying on from where it stopped.');
  return true;
}

export async function handOffToHuman(applicationId: string, page: Page, blocker: Blocker): Promise<void> {
  await artifact(applicationId, 'screenshot', 'blocked', await screenshot(page, applicationId, 'blocked'));
  await prisma.application.update({
    where: { id: applicationId },
    data: { status: 'NEEDS_HUMAN', blockedReason: `${blocker.kind}: ${blocker.detail}` },
  });
  await bus.emitEvent(applicationId, 'BLOCKED', blocker.detail, { kind: blocker.kind });
}

export async function handleOpenFailure(applicationId: string, page: Page, err: unknown): Promise<void> {
  if (err instanceof NeedsHumanError) {
    await handOffToHuman(applicationId, page, {
      kind: err.kind,
      detail: err.message,
      humanCanClear: true,
    });
    return;
  }
  if (err instanceof NoFormError) {
    // No form because the posting is gone: nothing for you to clear.
    if (await postingGone(page, err.diagnosis.url)) throw new PostingGoneError();
    await bus.emitEvent(applicationId, 'ERROR', describeDiagnosis(err.diagnosis));
    await handOffToHuman(applicationId, page, {
      kind: 'UNKNOWN',
      detail:
        `${err.message} ${describeDiagnosis(err.diagnosis)} ` +
        'The browser is still open on it - if you can see an application form there, the selectors need updating for this site.',
      humanCanClear: true,
    });
    return;
  }
  throw err;
}
