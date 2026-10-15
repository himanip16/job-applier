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
import { degreeLevel } from './repeatableSections.js';

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
async function fillPlannedField(planned: FormField, context: FillStepContext): Promise<boolean> {
  const { applicationId, page, adapter, answers, plan, afterHumanPause } = context;
  assertOpen(page, 'while the form was being filled');
  const answer = answers.get(planned.id);
  if (!answer || answer.value === null || answer.displayValue === '') {
    plan.push(entry(planned, answer, false));
    return false;
  }
  const field = await currentControl(context, planned);
  if (!field) {
    plan.push({ ...entry(planned, answer, false), error: 'no longer on the page' });
    await bus.emitEvent(
      applicationId,
      'LOG',
      `"${planned.label}" is no longer on the page (an earlier answer removed it), so it was left alone.`,
    );
    return false;
  }
  const wanted = answer.value as string | string[];
  const state = await inspectControl(page, field);
  // Resume parsers can lock identity fields that already contain the answer.
  if (state.locked) return recordLockedField(context, field, answer, state);
  if (afterHumanPause && (await preserveHumanValue(context, field, answer))) return false;

  const { check, failure } = await fillWithRecovery(applicationId, page, adapter, field, wanted);
  if (!check && /Could not find option/.test(failure)) {
    if (await fillListFallback(context, field, answer, wanted)) return false;
  }
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

/**
 * What else to look for when a dropdown has no option for the answer as
 * saved. Each is the same fact in the list's own words, never a guess:
 *
 * - School: a board's school list leaves out many colleges. IMC's Greenhouse
 *   list has no Haldia Institute of Technology at all, and a required School
 *   stopped the run. The list's "Other" is what a person would pick.
 * - Degree: "Bachelor of Technology" is listed as "Bachelor's Degree" or
 *   "Bachelors". Walmart's Workday degree list stopped on it.
 */
function listFallbacks(field: FormField, wanted: string | string[]): { values: string[]; why: string }[] {
  if (Array.isArray(wanted)) return [];
  const out: { values: string[]; why: string }[] = [];
  if (/degree|qualification/i.test(field.label) && !/field of study|discipline|major/i.test(field.label)) {
    const level = degreeLevel(wanted);
    if (level) {
      const word = level.replace(/'s\b.*$/, '');
      out.push({ values: [level, `${word}s`, word], why: `listed as the degree level` });
    }
  }
  if (/school|university|college|institution/i.test(field.label)) {
    out.push({ values: ['Other'], why: 'not in this form\'s school list, so "Other" was chosen' });
  }
  return out;
}

async function fillListFallback(
  { applicationId, page, adapter, plan }: FillStepContext,
  field: FormField,
  answer: ResolvedAnswer,
  wanted: string | string[],
): Promise<boolean> {
  for (const { values, why } of listFallbacks(field, wanted)) {
    for (const value of values) {
      const { check } = await fillWithRecovery(applicationId, page, adapter, field, value);
      if (!check?.ok) continue;
      const said = `"${truncate(String(wanted))}" is ${why} ("${value}").`;
      plan.push({ ...entry(field, answer, true), value, rationale: said, verified: check.actual });
      await bus.emitEvent(applicationId, 'LOG', `${field.label}: ${said}`);
      return true;
    }
  }
  return false;
}

const GENERATED_ID = /^(input|select|react-select|downshift|mui|headlessui|radix)[-_:]?[\w-]*\d+(-input)?$|^:r\w+:$/i;

/**
 * The control this field is on now, or null when the page has removed it.
 *
 * Handles are stamped on DOM nodes, and some forms rebuild a step around
 * them. On Microsoft's contact page, answering "Is your legal name the same
 * as your preferred name?" removes the two Legal Name boxes and React reuses
 * the nodes below, stamps and all: the handle for "Legal Last Name" then sat
 * on the country code picker, City's on a yes/no question, and every read-back
 * after that compared against the wrong control - correct values were
 * reported as not holding and the step stalled on them. The control's own
 * name or id survives the shuffle, so a stamp whose node no longer carries it
 * is moved back onto the node that does.
 *
 * Moved directly, not by re-reading the form: a re-read re-stamps every field
 * (so the next one looked moved too) and opens every dropdown to list its
 * options, and on Microsoft that cycled through the dropdowns indefinitely.
 */
async function currentControl(
  { applicationId, page }: FillStepContext,
  field: FormField,
): Promise<FormField | null> {
  // Generated ids ("input-15") are numbered by position and move with the
  // re-render, so they say nothing about which question a node is.
  if (!field.name || GENERATED_ID.test(field.name)) return field;
  const stamped = await page
    .locator(field.selector)
    .first()
    .evaluate(
      (node) =>
        node.getAttribute('name') ||
        node.getAttribute('id') ||
        node.querySelector('input')?.getAttribute('name') ||
        '',
      undefined,
      { timeout: 2_000 },
    )
    .catch(() => null);
  // Unknown identity is not evidence of a move; the fill path still recovers.
  if (stamped === '' || stamped === field.name) return field;
  const handle = /data-ja-field="([^"]+)"/.exec(field.selector)?.[1];
  if (!handle) return field;
  const restamped = await page
    .evaluate(
      ({ handle, name }) => {
        const target = Array.from(document.querySelectorAll('[name], [id]')).find(
          (n) => n.getAttribute('name') === name || n.id === name,
        );
        if (!target) return false;
        document.querySelectorAll(`[data-ja-field="${handle}"]`).forEach((n) => n.removeAttribute('data-ja-field'));
        target.setAttribute('data-ja-field', handle);
        return true;
      },
      { handle, name: field.name },
    )
    .catch(() => null);
  if (restamped) {
    await bus.emitEvent(applicationId, 'LOG', `"${field.label}" moved when the page re-rendered; found it again.`);
    return field;
  }
  // Could not look: let the fill path try. Looked and it is not there: gone.
  return restamped === null || stamped === null ? field : null;
}

async function recordLockedField(
  { applicationId, page, plan }: FillStepContext,
  field: FormField,
  answer: ResolvedAnswer,
  state: ControlState,
): Promise<boolean> {
  const wanted = answer.value as string | string[];
  let shown = state.current;
  let correct = alreadyHolds(shown, wanted);
  // A locked dropdown's input is empty; its choice is drawn beside it.
  // Microsoft shows the screening answers from the job page this way, and
  // reading only the input called every one of them wrong.
  if (!correct && field.widget !== 'native') {
    const check = await verifyFilled(page, field, wanted);
    correct = check.ok;
    shown = check.actual || shown;
  }
  plan.push({
    ...entry(field, answer, correct),
    verified: shown,
    error: correct
      ? undefined
      : `The site locked this field and it holds ${shown ? `"${truncate(shown)}"` : 'nothing'}.`,
  });
  await bus.emitEvent(
    applicationId,
    correct ? 'LOG' : 'WARNING',
    correct
      ? `"${field.label}" is locked by the site and already holds the right value.`
      : `"${field.label}" is locked by the site and cannot be changed from here` +
          `${shown ? ` (it shows "${truncate(shown)}")` : ''}; it is flagged for review.`,
  );
  // Never a reason to pause: you cannot change a locked field in the browser
  // either, so waiting on it only stalled the step. Review shows the flag.
  return false;
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
): Promise<{ check: Awaited<ReturnType<typeof verifyFilled>> | null; failure: string }> {
  const attempt = async (target: FormField) => {
    await fillField(page, target, wanted);
    return verifyFilled(page, target, wanted);
  };

  let check: Awaited<ReturnType<typeof verifyFilled>> | null = null;
  let failure = '';
  try {
    check = await attempt(field);
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
    if (wanted.name && !GENERATED_ID.test(wanted.name)) {
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
