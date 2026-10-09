import type { Page } from 'playwright';
import { normalizeLabel, type FormField, type ResolvedAnswer } from '@ja/shared';
import type { AtsAdapter } from '../ats/types.js';
import { assertOpen } from '../browser/session.js';
import {
  fillField, verifyFilled, inspectControl, alreadyHolds, FillError, type ControlState,
} from '../browser/fill.js';
import { bus } from '../lib/events.js';
import { entry, type FieldPlanEntry } from './fieldPlan.js';
import { truncate } from './runLog.js';

interface FillStepContext {
  applicationId: string;
  page: Page;
  adapter: AtsAdapter;
  answers: Map<string, ResolvedAnswer>;
  plan: FieldPlanEntry[];
  afterHumanPause: boolean;
}

/** Fill one screen and report only failures that require intervention. */
export async function fillApplicationFields(
  fields: FormField[],
  context: FillStepContext,
): Promise<string[]> {
  const unfilledRequired: string[] = [];
  for (const field of fields) {
    if (await fillPlannedField(field, context)) unfilledRequired.push(field.label);
  }
  return unfilledRequired;
}

/** Returns whether a required control could not be filled. */
async function fillPlannedField(field: FormField, context: FillStepContext): Promise<boolean> {
  const { applicationId, page, adapter, answers, plan, afterHumanPause } = context;
  assertOpen(page, 'while the form was being filled');
  const answer = answers.get(field.id);
  if (!answer || answer.value === null || answer.displayValue === '') {
    plan.push(entry(field, answer, false));
    return false;
  }
  const wanted = answer.value as string | string[];
  const state = await inspectControl(page, field);
  // Resume parsers can lock identity fields that already contain the answer.
  if (state.locked) return recordLockedField(context, field, answer, state);
  if (afterHumanPause && (await preserveHumanValue(context, field, answer))) return false;

  const { check, failure } = await fillWithRecovery(applicationId, page, adapter, field, wanted, state);
  if (check) {
    plan.push({
      ...entry(field, answer, true),
      verified: check.actual,
      error: check.ok ? undefined : 'value did not stick',
    });
    if (!check.ok) {
      await bus.emitEvent(
        applicationId,
        'WARNING',
        `"${field.label}" did not hold the value we set (page shows: ${truncate(check.actual)}).`,
      );
    }
    return false;
  }

  plan.push({ ...entry(field, answer, false), error: failure });
  await bus.emitEvent(applicationId, 'WARNING', `Could not fill "${field.label}": ${failure}`);
  return field.required;
}

async function recordLockedField(
  { applicationId, plan }: FillStepContext,
  field: FormField,
  answer: ResolvedAnswer,
  state: ControlState,
): Promise<boolean> {
  const wanted = answer.value as string | string[];
  const correct = alreadyHolds(state.current, wanted);
  plan.push({
    ...entry(field, answer, correct),
    verified: state.current,
    error: correct
      ? undefined
      : `The site locked this field and it holds ${
          state.current ? `"${truncate(state.current)}"` : 'nothing'
        }.`,
  });
  await bus.emitEvent(
    applicationId,
    correct ? 'LOG' : 'WARNING',
    correct
      ? `"${field.label}" is locked by the site and already holds the right value.`
      : `"${field.label}" is locked by the site and cannot be changed from here.`,
  );
  return !correct && field.required;
}

/** Keep nonblank browser edits after a human pause, even when they differ. */
async function preserveHumanValue(
  { applicationId, page, plan }: FillStepContext,
  field: FormField,
  answer: ResolvedAnswer,
): Promise<boolean> {
  const wanted = answer.value as string | string[];
  const now = await verifyFilled(page, field, wanted);
  const shown = now.actual.trim();
  const blank = !shown || /^(select\b|not ticked$|verification failed)/i.test(shown);
  if (now.ok || !blank) {
    plan.push({
      ...entry(field, answer, true),
      ...(now.ok
        ? {}
        : { value: shown, source: 'USER', confidence: 1, rationale: 'You set this in the browser.' }),
      verified: shown,
    });
    if (!now.ok) {
      await bus.emitEvent(applicationId, 'LOG', `Keeping what you entered for "${field.label}": ${truncate(shown)}.`);
    }
    return true;
  }
  return false;
}

async function fillWithRecovery(
  applicationId: string,
  page: Page,
  adapter: AtsAdapter,
  field: FormField,
  wanted: string | string[],
  state: ControlState,
): Promise<{ check: Awaited<ReturnType<typeof verifyFilled>> | null; failure: string }> {
  const attempt = async (target: FormField, known?: ControlState) => {
    await fillField(page, target, wanted, known);
    return verifyFilled(page, target, wanted);
  };

  let check: Awaited<ReturnType<typeof verifyFilled>> | null = null;
  let failure = '';
  try {
    // A refound field is a new node, so only this first attempt reuses the read.
    check = await attempt(field, state);
  } catch (err) {
    failure = err instanceof FillError ? err.message : (err as Error).message;

    // Filling one control routinely re-renders its neighbours — a phone
    // country picker rebuilds the number input beside it — and the
    // handle we stamped during extraction then points at a node that no
    // longer exists. Look the field up again by label before believing
    // it cannot be filled.
    const fresh = await refindField(page, adapter, field);
    if (fresh) {
      try {
        check = await attempt(fresh);
        failure = '';
        await bus.emitEvent(
          applicationId,
          'LOG',
          `"${field.label}" had been re-rendered; found it again and filled it.`,
        );
      } catch (retryErr) {
        failure = retryErr instanceof FillError ? retryErr.message : (retryErr as Error).message;
      }
    }
  }
  return { check, failure };
}

/**
 * Find a field again after the page has rebuilt it.
 *
 * Handles are stamped onto elements during extraction, so anything that
 * re-renders invalidates them - and filling a control is one of the most
 * common ways to make that happen. Re-extracting and matching on the label is
 * the cheap recovery, and it is worth doing before reporting that a required
 * field cannot be filled at all.
 */
async function refindField(
  page: Page,
  adapter: { extractForm: (page: Page) => Promise<FormField[]> },
  wanted: FormField,
): Promise<FormField | null> {
  try {
    const fields = await adapter.extractForm(page);
    const target = normalizeLabel(wanted.label);

    // The control's own name, which survives a re-render. Matching on the
    // label alone is not enough and quietly does the wrong thing: Greenhouse's
    // phone block labels both the country picker and the number input "Phone",
    // so a lookup by label refound the wrong one, left the number empty, and
    // the submission was rejected for a field that looked filled.
    if (wanted.name) {
      const byName = fields.find((f) => f.name === wanted.name);
      if (byName) return byName;
    }
    if (wanted.canonicalKey) {
      const byKey = fields.find((f) => f.canonicalKey === wanted.canonicalKey);
      if (byKey) return byKey;
    }

    // Last resort: the same label AND the same kind, and only when that is
    // unambiguous. Guessing between two identically-labelled controls is worse
    // than admitting we cannot find it.
    const byLabel = fields.filter(
      (f) => normalizeLabel(f.label) === target && f.kind === wanted.kind,
    );
    return byLabel.length === 1 ? byLabel[0]! : null;
  } catch {
    return null;
  }
}
