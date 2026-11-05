import type { Page } from 'playwright';
import { type FormField } from '@ja/shared';
import { bus } from '../lib/events.js';
import { setStatus } from './runLog.js';
import type { WalkContext, WalkState } from './wizard.js';
import {
  expandRepeatableSections,
  hasRepeatableSections,
  historyFromFacts,
  labelRepeatableFields,
  readResumeHistory,
  type ResumeHistory,
} from './repeatableSections.js';
import { reuseCachedAnswers } from './answerCache.js';
import { readStepProgress, looksLikeAGate } from '../browser/steps.js';
import { rekeyRereadStep, carryOverEarlierReplies } from './answerReuse.js';

export async function readStepFields(
  context: WalkContext,
  state: WalkState,
  signature: string,
): Promise<{ fields: FormField[]; rowsDeferred: boolean }> {
  const { applicationId, page, adapter, earlierReplies, earlierDerived, ctx } = context;
  const { sessionAnswers } = ctx;
  // Extraction re-stamps handles; the last read's no longer point at its controls.
  context.edits.forget();
  const progress = await readStepProgress(page);
  await setStatus(applicationId, 'FILLING', describeStep(state.step, progress), { progress });

  const gate = await looksLikeAGate(page);
  let fields: FormField[] = [];
  let rowsDeferred = false;
  if (!gate) {
    // Handles restart at f0 on every extraction, so they are namespaced by
    // step before anything stores them - otherwise step 2's "f0" would
    // overwrite step 1's answer and its pending question.
    const sections = await hasRepeatableSections(page);
    // Resume first, then everything else. Workday's My Experience puts the
    // resume upload beside Work Experience and Education, and its parser adds
    // rows of its own - so adding rows before the upload left duplicates.
    // Hold the rows back once per screen; the walk attaches and reads again.
    rowsDeferred =
      sections &&
      !state.resumeAttached &&
      state.rowsDeferredOn !== signature &&
      (await page.locator('input[type="file"]').count().catch(() => 0)) > 0;
    if (rowsDeferred) state.rowsDeferredOn = signature;
    const history = sections && !rowsDeferred ? await workHistory(context) : null;
    if (history) {
      for (const r of await expandRepeatableSections(page, history)) {
        if (r.after === r.before) continue;
        await bus.emitEvent(
          applicationId,
          'LOG',
          `Added ${r.kind} rows: ${r.before} -> ${r.after} (you have ${r.wanted} on record).`,
        );
      }
    }
    fields = (await adapter.extractForm(page)).map((f: FormField) => ({ ...f, id: `s${state.step}:${f.id}` }));
    // Every row repeats the same labels; name each after the entry it is for.
    if (sections) fields = await labelRepeatableFields(page, fields, history);
    rekeyRereadStep(fields, state, sessionAnswers);
    state.allFields.push(...fields);
    carryOverEarlierReplies(fields, earlierReplies, sessionAnswers);
    reuseCachedAnswers(fields, earlierDerived, sessionAnswers);
    await bus.emitEvent(
      applicationId,
      'FORM_EXTRACTED',
      `Step ${state.step}: ${fields.length} field(s), ${fields.filter((f) => f.required).length} required.`,
      { step: state.step, fields },
    );
  }

  // Once the resume is in, Workday's "Autofill with Resume" step swaps its drop
  // zone for a file card and has no inputs left - that is the step done, not a
  // wall. Fall through to Continue so its parser fills the next steps.
  if (gate && state.step === 1 && !state.resumeAttached) {
    throw new Error(
      'No form fields found on the page. The posting may be closed, or the form behind a wall.',
    );
  }
  return { fields, rowsDeferred };
}

/** Saved employment.N / education.N facts first; the resume only when there are none. */
export async function workHistory(context: WalkContext): Promise<ResumeHistory | null> {
  if (context.history === undefined) {
    context.history =
      historyFromFacts(context.app.profile.facts) ??
      (await readResumeHistory(context.ctx.candidateContext).catch(() => null));
  }
  return context.history;
}

/** "Step 3 of 5: Application Questions", when the page says that much. */
function describeStep(
  step: number,
  progress: { index: number | null; total: number | null; label: string | null },
): string {
  const where =
    progress.index && progress.total
      ? `Step ${progress.index} of ${progress.total}`
      : `Step ${step}`;
  return progress.label ? `${where}: ${progress.label}` : where;
}
