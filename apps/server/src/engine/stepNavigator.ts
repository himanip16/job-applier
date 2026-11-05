import type { Page } from 'playwright';
import { bus } from '../lib/events.js';
import { PageClosedError, screenshot } from '../browser/session.js';
import {
  detectAutofillPrompt,
  findAdvanceControl,
  isNavigationRace,
  pageSignature,
  readValidationErrors,
  waitForStepChange,
  type AdvanceControl,
} from '../browser/steps.js';
import type { WalkContext, WalkState } from './wizard.js';
import { pauseForHuman } from './humanGate.js';
import { artifact } from './runLog.js';
import type { FormField } from '@ja/shared';

export type StepOutcome = 'CONTINUE' | 'ABANDONED' | 'REACHED_END';

/**
 * A required SuccessFactors picklist that was read with no choices and can be
 * opened now - its parent was picked by this pass.
 */
export async function awaitingParentPick(page: Page, fields: FormField[]): Promise<boolean> {
  for (const f of fields) {
    if (!f.required || f.widget !== 'react-select' || f.options?.length) continue;
    const ready = await page
      .locator(f.selector)
      .first()
      .evaluate((el) => !!el.closest('.sfCascadingPicklist') && !(el as HTMLInputElement).disabled, undefined, {
        timeout: 2_000,
      })
      .catch(() => false);
    if (ready) return true;
  }
  return false;
}

export async function advanceStep(
  context: WalkContext,
  state: WalkState,
  signature: string,
): Promise<StepOutcome> {
  const { applicationId, page, adapter, edits } = context;
  // An upload or save can hold the continue button disabled for a moment.
  await adapter.settle?.(page);
  let advance = await findAdvanceControl(page);
  // "Submit" on a step that is not the last one only moves the form along.
  if (advance?.kind === 'SUBMIT' && adapter.isFinalStep && !(await adapter.isFinalStep(page).catch(() => true))) {
    advance = { ...advance, kind: 'NEXT' };
  }
  if (!advance && (await detectAutofillPrompt(page))) {
    // Never the end of a form: it is the screen before the first step.
    throw new Error(
      'Stuck on the site\'s "Autofill with Resume / Apply Manually" screen: choosing did not open the form.',
    );
  }
  if (!advance) {
    // Nothing to press. On a one-page form that is normal - the adapter
    // knows how to submit it. Mid-wizard it means the markup changed.
    await bus.emitEvent(
      applicationId,
      'LOG',
      state.step === 1
        ? 'Single-page form; handing over to the adapter to submit.'
        : `No next or submit control on step ${state.step}; letting the adapter try to submit.`,
    );
    return 'REACHED_END';
  }

  if (advance.kind === 'SUBMIT') {
    state.submitControl = advance;
    await bus.emitEvent(
      applicationId,
      'LOG',
      `Reached the end of the application ("${advance.label}") after ${state.step} step(s).`,
    );
    return 'REACHED_END';
  }

  await artifact(
    applicationId,
    'screenshot',
    `step-${state.step}`,
    await screenshot(page, applicationId, `step-${state.step}`),
  ).catch(() => {});

  // Last look before the step's values leave the screen.
  await edits.capture();
  await page.click(advance.selector).catch(async (err: unknown) => {
    throw new Error(`Could not press "${advance.label}": ${(err as Error).message}`);
  });
  const moved = await waitForStepChange(page, signature, 20_000);
  if (!moved) return handleRejectedStep(context, state, signature, advance);
  edits.forget();
  state.stuckSignature = null;
  state.navigationRetries = 0;
  return 'CONTINUE';
}

async function handleRejectedStep(
  { applicationId, page, edits }: WalkContext,
  state: WalkState,
  signature: string,
  advance: AdvanceControl,
): Promise<StepOutcome> {
  // Pressing continue changed nothing. Almost always the step is
  // rejecting something; occasionally the button was not the one that
  // moves forward. Either way the page's own complaint is the useful
  // thing to report, not "the page did not change".
  const errors = await readValidationErrors(page);
  const detail = errors.length
    ? `Step ${state.step} would not accept the form: ${errors.join(' · ')}`
    : `Pressing "${advance.label}" on step ${state.step} did not move the application on, and the ` +
      'page gave no reason.';

  if (state.stuckSignature === signature) {
    const carryOn = await edits.during(pauseForHuman(applicationId, page, {
      kind: 'UNKNOWN',
      detail: `${detail} The browser is open on it - fix it there and continue, or cancel.`,
      humanCanClear: true,
      autoClears: false,
    }));
    if (!carryOn) return 'ABANDONED';
    state.afterHumanPause = true;
    state.stuckSignature = null;
    return 'CONTINUE';
  }

  // First failure: re-read the step. A rejected submit often reveals
  // fields that were not rendered before, and filling those is exactly
  // what the next iteration does.
  state.stuckSignature = signature;
  await bus.emitEvent(applicationId, 'WARNING', `${detail} Re-reading the step.`);
  state.step--;
  return 'CONTINUE';
}

export async function pauseForRequiredFields(
  { applicationId, page, edits }: WalkContext,
  state: WalkState,
  unfilledRequired: string[],
): Promise<StepOutcome> {
  // Path and heading only: the field list changes under your hands as you
  // answer (Microsoft drops the Legal Name boxes on "same name? Yes").
  const where = (sig: string) => sig.split('#').slice(0, 2).join('#');
  const here = where(await pageSignature(page));
  let movedOn = false;
  const carryOn = await edits.during(pauseForHuman(applicationId, page, {
    clearedWhen: async () => {
      const now = await pageSignature(page).catch(() => '');
      movedOn = Boolean(now) && where(now) !== here;
      return movedOn;
    },
    kind: 'UNKNOWN',
    detail:
      `Could not fill ${unfilledRequired.map((l) => `"${l}"`).join(', ')}, which ` +
      `${unfilledRequired.length === 1 ? 'is' : 'are'} required. Everything else on this step ` +
      'is filled in - set those in the open browser and it will carry on.',
    humanCanClear: true,
    autoClears: false,
  }));
  if (!carryOn) return 'ABANDONED';
  // You pressed Next yourself: this is a new step, read it as one.
  if (movedOn) return 'CONTINUE';
  state.afterHumanPause = true;
  state.step--;
  return 'CONTINUE';
}

export async function recoverNavigation(
  { applicationId, page }: WalkContext,
  state: WalkState,
  err: unknown,
): Promise<void> {
  // The page moved while we were working on it. That is a wizard doing
  // its job, not a failure - look at wherever it landed instead. Bounded,
  // because a page that navigates on a timer would otherwise spin here
  // forever without ever making progress.
  // A closed tab also reads as "Target closed"; it is not coming back.
  if (page.isClosed() && !(err instanceof PageClosedError)) {
    throw new PageClosedError('while the form was being filled');
  }
  if (!isNavigationRace(err) || state.navigationRetries >= 4) throw err;
  state.navigationRetries++;
  state.step--;
  await bus.emitEvent(
    applicationId,
    'LOG',
    `The page navigated while it was being read; looking at where it landed (${state.navigationRetries}/4).`,
  );
}
