import type { Page } from 'playwright';
import { getCanonical, type FormField, type ResolvedAnswer } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { bus } from '../lib/events.js';
import { screenshot, saveDom, unlessClosed } from '../browser/session.js';
import { detectBlockers, detectSubmissionOutcome } from '../browser/blockers.js';
import type { AdvanceControl } from '../browser/steps.js';
import type { AtsAdapter } from '../ats/types.js';
import { rememberAnswer } from './answerBank.js';
import { abandon, park, reviewKey } from './waiters.js';
import { artifact, setStatus } from './runLog.js';
import { markLeadApplied } from './leadSync.js';
import { whileWaitingOnHuman } from './slots.js';
import type { FieldPlanEntry } from './fieldPlan.js';
import { recordManualSubmit, watchForManualSubmit } from './manualSubmit.js';

/**
 * The last few feet, which are the ones that matter.
 *
 * Everything up to here is reversible. This is not, so two rules hold
 * throughout: nothing is submitted without the human's go-ahead when review is
 * on (autopilot is review switched off for that application), and nothing is *recorded* as submitted without a confirmation actually
 * visible on the page. An application that may or may not have gone through is
 * reported as needing a human, never as done.
 */
export class SubmissionBudgetError extends Error {}

export async function finishApplication(args: {
  applicationId: string;
  page: Page;
  adapter: AtsAdapter;
  app: { requiresReview: boolean; profileId: string };
  plan: FieldPlanEntry[];
  answers: Map<string, ResolvedAnswer>;
  fields: FormField[];
  submitControl: AdvanceControl | null;
  companyKey: string;
}): Promise<void> {
  const { applicationId, page, adapter, app, plan, answers, fields, submitControl, companyKey } =
    args;

  const fillable = fields.filter((f) => f.kind !== 'FILE');
  await artifact(applicationId, 'screenshot', 'filled', await screenshot(page, applicationId, 'filled'));
  await artifact(applicationId, 'dom', 'filled-dom', await saveDom(page, applicationId, 'filled'));

  // ---- Blockers, second look ---------------------------------------------
  const blockers = await detectBlockers(page);
  const captcha = blockers.find((b) => b.kind === 'CAPTCHA');
  // Armed is not blocked. Invisible reCAPTCHA is on every Greenhouse form and
  // usually passes on submit; setting aside every one of those meant autopilot
  // never submitted a Greenhouse job at all. Only a challenge already showing
  // needs a person before the click - one that appears on submit is caught after.
  const challenge = captcha?.onScreen ? captcha : undefined;

  // ---- Review gate ---------------------------------------------------------
  //
  // Autopilot (review off for this application) skips the go-ahead, but not
  // the things only a person can do: a captcha, a field that would not fill,
  // or a final step nobody has mapped that the walk found no button for.
  // Those are set aside so the queue moves on instead of waiting.
  const autopilot = !app.requiresReview;
  const unmappedEnd = (adapter.id === 'generic' || !!adapter.alwaysReview) && !(autopilot && submitControl);
  const needsHands = !!challenge || plan.some((p) => p.error) || unmappedEnd;

  if (autopilot && needsHands) {
    const reason = challenge
      ? `${challenge.detail} The form is filled and open in the browser.`
      : unmappedEnd
        ? 'Could not find the final submit button on this site. The form is filled and open in the browser.'
        : 'Some fields would not fill. The form is open in the browser.';
    await setAside(applicationId, reason);
    return;
  }
  if (autopilot && captcha) {
    await bus.emitEvent(applicationId, 'LOG', `${captcha.detail} Submitting anyway; if it challenges, this is set aside for you.`);
  }

  if (!autopilot) {
    const reason = captcha
      ? `${captcha.detail} The form is filled and waiting; solve the challenge in the browser, then approve here.`
      : adapter.id === 'generic'
        ? 'Unrecognised site, so this always goes through review.'
        : adapter.alwaysReview
          ? `The ${adapter.id} final step has not been mapped yet, so this always goes through review.`
        : 'Filled and ready. Check it over, then approve.';
    // Register the waiter BEFORE announcing the status. Anything watching the
    // run - the UI, the CLI, a test - can observe REVIEW and answer within
    // microseconds, and if the parked promise does not exist yet that reply
    // is dropped and the run waits forever.
    const decisionPromise = park<{ approved: boolean; note?: string }>(reviewKey(applicationId));
    await setStatus(applicationId, 'REVIEW', reason, { blockers, plan });
    // Pressing the site's own submit button is a go-ahead too.
    const stopWatching = new AbortController();
    const decision = await whileWaitingOnHuman(
      applicationId,
      unlessClosed(
        page,
        Promise.race([
          decisionPromise,
          watchForManualSubmit(page, stopWatching.signal).then((detail) => ({ approved: true, manual: detail })),
        ]),
        'while waiting for your review',
      ),
    ).finally(() => stopWatching.abort());
    if ('manual' in decision) {
      abandon(reviewKey(applicationId));
      await recordManualSubmit(applicationId, page, decision.manual);
      await persistLearnedAnswers(applicationId, app.profileId, fillable, answers, companyKey);
      return;
    }
    if (!decision.approved) {
      await setStatus(applicationId, 'CANCELLED', decision.note ?? 'You cancelled this application.');
      return;
    }
  }

  // ---- Submit ---------------------------------------------------------------
  //
  // The walk usually ends holding the actual final button, which is more
  // reliable than the adapter's generic selector - on a wizard, "the submit
  // button" and "the button that ends the application" are only the same
  // thing on the last screen.
  const pressSubmit = async () => {
    if (submitControl) {
      await page.click(submitControl.selector);
      return;
    }
    await adapter.submit(page);
  };

  // Checking the cap and claiming a place under it happen as one step, or two
  // parallel runs could both see 9/10 and both submit. Autopilot waits for
  // room outside the lock, so it never holds up anyone else's submit.
  for (;;) {
    await enforceSubmitBudget(autopilot ? applicationId : null);
    const claimed = await withSubmitLock(async () => {
      if ((await recentSubmits()) >= config.maxSubmitsPerHour) {
        if (autopilot) return false;
        await enforceSubmitBudget(null);
      }
      await setStatus(
        applicationId,
        'SUBMITTING',
        submitControl ? `Submitting ("${submitControl.label}").` : 'Submitting.',
      );
      return true;
    });
    if (claimed) break;
  }
  const urlBefore = page.url();
  await pressSubmit();
  let outcome = await detectSubmissionOutcome(page, urlBefore);

  // The armed captcha challenged. Nothing was sent: the click is held until it
  // is solved, and solving it usually submits the form by itself.
  if (outcome.outcome !== 'SUBMITTED' && (await captchaOnScreen(page))) {
    const detail = 'A captcha challenge appeared when submitting, so nothing has been sent yet.';
    if (autopilot) {
      await setAside(
        applicationId,
        `${detail} Solve it in the open browser tab (it usually submits by itself), then mark it as submitted here.`,
      );
      return;
    }
    await setStatus(
      applicationId,
      'NEEDS_HUMAN',
      `${detail} Solve it in the browser window; this carries on by itself once the site confirms.`,
      { handoff: 'CAPTCHA_ON_SUBMIT' },
    );
    if (!config.headless) await page.bringToFront().catch(() => {});
    process.stdout.write(`\x07[needs you] CAPTCHA on submit\n`);
    outcome = await whileWaitingOnHuman(
      applicationId,
      unlessClosed(page, detectSubmissionOutcome(page, urlBefore, 10 * 60_000), 'while waiting for the captcha'),
    );
  }
  await artifact(applicationId, 'screenshot', 'after-submit', await screenshot(page, applicationId, 'after-submit'));

  if (outcome.outcome === 'SUBMITTED') {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: 'SUBMITTED', submittedAt: new Date(), confirmation: outcome.detail, blockedReason: null },
    });
    await bus.emitEvent(applicationId, 'STATUS', 'Submitted.', { status: 'SUBMITTED' });
    await markLeadApplied(applicationId);
    await persistLearnedAnswers(applicationId, app.profileId, fillable, answers, companyKey);
    return;
  }

  if (outcome.outcome === 'VALIDATION_ERROR' && autopilot) {
    await setAside(applicationId, `The form rejected the submission: ${outcome.detail}. It is still open in the browser.`);
    return;
  }

  if (outcome.outcome === 'VALIDATION_ERROR') {
    const retryPromise = park<{ approved: boolean; note?: string }>(reviewKey(applicationId));
    await setStatus(
      applicationId,
      'REVIEW',
      `The form rejected the submission: ${outcome.detail}. It is still open in the browser - fix it there and approve, or cancel.`,
    );
    const retry = await whileWaitingOnHuman(
      applicationId,
      unlessClosed(page, retryPromise, 'while waiting for your review'),
    );
    if (!retry.approved) {
      await setStatus(applicationId, 'CANCELLED', retry.note ?? 'Cancelled after a validation error.');
      return;
    }
    await pressSubmit();
    const second = await detectSubmissionOutcome(page, urlBefore);
    await prisma.application.update({
      where: { id: applicationId },
      data:
        second.outcome === 'SUBMITTED'
          ? { status: 'SUBMITTED', submittedAt: new Date(), confirmation: second.detail }
          : { status: 'FAILED', blockedReason: second.detail },
    });
    await bus.emitEvent(applicationId, 'STATUS', second.outcome, { status: second.outcome });
    if (second.outcome === 'SUBMITTED') {
      await markLeadApplied(applicationId);
      await persistLearnedAnswers(applicationId, app.profileId, fillable, answers, companyKey);
    }
    return;
  }

  // Ambiguous. Never claim success we cannot see.
  await prisma.application.update({
    where: { id: applicationId },
    data: { status: 'NEEDS_HUMAN', blockedReason: outcome.detail },
  });
  await bus.emitEvent(
    applicationId,
    'STATUS',
    'Submitted, but no confirmation was visible. Check the browser before assuming it went through.',
    { status: 'NEEDS_HUMAN', detail: outcome.detail, handoff: 'UNCONFIRMED' },
  );
}

/**
 * Autopilot hands over and moves on rather than parking. The page stays open
 * (the runner leaves it) so you can finish it there by hand.
 */
async function setAside(applicationId: string, reason: string): Promise<void> {
  await prisma.application.update({
    where: { id: applicationId },
    data: { status: 'NEEDS_HUMAN', blockedReason: `${reason} Autopilot moved on to the next job.` },
  });
  await bus.emitEvent(applicationId, 'STATUS', `Set aside: ${reason}`, {
    status: 'NEEDS_HUMAN',
    handoff: 'SET_ASIDE',
  });
}

async function captchaOnScreen(page: Page): Promise<boolean> {
  const blockers = await detectBlockers(page).catch(() => []);
  return blockers.some((b) => b.kind === 'CAPTCHA' && b.onScreen);
}

let submitLock: Promise<unknown> = Promise.resolve();

function withSubmitLock<T>(fn: () => Promise<T>): Promise<T> {
  const turn = submitLock.then(fn);
  submitLock = turn.catch(() => {});
  return turn;
}

/**
 * The hourly cap. A run you are watching fails when it is reached; an
 * autopilot run waits for room, since the whole point is to keep going.
 *
 * Runs mid-submit count too: with several filling at once, one can be past
 * this check and not yet SUBMITTED when the next one arrives.
 */
function recentSubmits(): Promise<number> {
  return prisma.application.count({
    where: {
      OR: [
        { status: 'SUBMITTED', submittedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
        { status: 'SUBMITTING' },
      ],
    },
  });
}

async function enforceSubmitBudget(waitingRun: string | null): Promise<void> {
  let recent = await recentSubmits();
  if (waitingRun && recent >= config.maxSubmitsPerHour) {
    await bus.emitEvent(
      waitingRun,
      'LOG',
      `Hourly limit reached (${recent}/${config.maxSubmitsPerHour}). Waiting for room, then submitting.`,
    );
    while (recent >= config.maxSubmitsPerHour) {
      await new Promise((r) => setTimeout(r, 60_000));
      recent = await recentSubmits();
    }
  }
  if (recent >= config.maxSubmitsPerHour) {
    throw new SubmissionBudgetError(
      `Submission budget reached (${recent}/${config.maxSubmitsPerHour} in the last hour). ` +
        'This cap exists so a bug cannot spray fifty applications in your name.',
    );
  }
}

/**
 * Write the answers worth keeping into the bank, after a confirmed submit.
 * Doing it here rather than at resolve time means a run that dies halfway
 * never poisons the bank with values that were never actually accepted.
 */
async function persistLearnedAnswers(
  applicationId: string,
  profileId: string,
  fields: FormField[],
  answers: Map<string, ResolvedAnswer>,
  companyKey: string,
): Promise<void> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  let saved = 0;
  for (const [fieldId, answer] of answers) {
    if (!answer.remember && answer.source !== 'USER') continue;
    if (answer.source === 'GENERATED' || answer.source === 'SKIPPED') continue;
    const field = byId.get(fieldId);
    if (!field || answer.value === null) continue;
    const canonical = answer.canonicalKey ? getCanonical(answer.canonicalKey) : undefined;
    await rememberAnswer({
      profileId,
      canonicalKey: answer.canonicalKey,
      rawLabel: field.label,
      value: answer.value,
      displayValue: answer.displayValue,
      fieldKind: field.kind,
      options: field.options,
      source: answer.source === 'USER' ? 'USER' : 'INFERRED',
      confidence: answer.confidence,
      scope: canonical?.perCompany ? 'PER_COMPANY' : 'GLOBAL',
      companyKey,
    });
    saved++;
  }
  if (saved) {
    await bus.emitEvent(
      applicationId,
      'MEMORY_WRITTEN',
      `Saved ${saved} answer${saved === 1 ? '' : 's'} to your answer bank. Future applications will reuse them.`,
    );
  }
}
