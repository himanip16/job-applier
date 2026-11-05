import type { Page } from 'playwright';
import { normalizeLabel, type AnswerGap, type FormField, type ResolvedAnswer } from '@ja/shared';
import { bus } from '../lib/events.js';
import { truncate } from './runLog.js';
import { resolveFields, type ResolveContext } from './resolver.js';
import { askHuman } from './humanGate.js';
import { saveToAnswerCache } from './answerCache.js';
import type { WalkContext, WalkState } from './wizard.js';
import { inspectControl, readShown } from '../browser/fill.js';

/** Resolve what we can; returns the required fields nothing answered. */
export async function resolveStepAnswers(
  { applicationId, ctx }: WalkContext,
  state: WalkState,
  fillable: FormField[],
): Promise<AnswerGap[]> {
  const gaps: AnswerGap[] = [];
  const resolved = await resolveFields(fillable, ctx);
  // Keep what the model worked out before anything can go wrong, so a
  // restart reuses it instead of paying for it again.
  await saveToAnswerCache(
    applicationId,
    fillable,
    new Map([...resolved].flatMap(([id, r]) => (r.kind === 'answer' ? [[id, r.answer] as const] : []))),
  );
  for (const field of fillable) {
    const res = resolved.get(field.id)!;
    if (res.kind === 'answer') {
      state.answers.set(field.id, res.answer);
      await bus.emitEvent(
        applicationId,
        'FIELD_RESOLVED',
        `${field.label}: ${res.answer.displayValue} [${res.answer.source}]`,
        { fieldId: field.id, source: res.answer.source, confidence: res.answer.confidence },
      );
    } else if (!field.required || followsANo(field, fillable, state.answers)) {
      // Questions are asked before anything is filled, so one optional box we
      // cannot answer (ServiceNow's Facebook, X and "Message to the Hiring
      // Team") left the whole form blank while the run waited on you. Blank
      // is a legitimate answer to an optional question; a guess is not.
      state.answers.set(field.id, {
        fieldId: field.id,
        value: null,
        displayValue: '',
        source: 'SKIPPED',
        confidence: 1,
        rationale: field.required
          ? 'Follow-up to a question answered No, so it does not apply and is left blank.'
          : 'Optional, and nothing in your profile answers it, so it is left blank.',
        remember: false,
        canonicalKey: field.canonicalKey,
      });
      const why = field.required ? 'follow-up to a No' : 'optional';
      await bus.emitEvent(applicationId, 'FIELD_RESOLVED', `${field.label}: left blank (${why}) [SKIPPED]`, {
        fieldId: field.id,
        source: 'SKIPPED',
        confidence: 1,
      });
    } else {
      gaps.push(res.gap);
    }
  }

  return gaps;
}

/**
 * Ask about the required fields nothing answered, once the rest is filled,
 * and return the ones that now have an answer.
 *
 * Filling can settle a question by itself: ticking "I currently work here"
 * removes or disables the "To" date it was asked about. Those are dropped
 * rather than put to you.
 */
export async function askAboutGaps(
  { applicationId, page, ctx }: WalkContext,
  state: WalkState,
  fillable: FormField[],
  gaps: AnswerGap[],
): Promise<FormField[]> {
  const byId = new Map(fillable.map((f) => [f.id, f]));
  const open: AnswerGap[] = [];
  for (const gap of gaps) {
    const field = byId.get(gap.fieldId);
    if (!field) continue;
    const control = await inspectControl(page, field);
    if (!control.exists || control.locked) continue;
    // What the page shows, not input.value: every radio carries a value
    // whether or not it is picked. A site default that is already selected
    // (Okta's "Upload PDF") stands, rather than being put to you.
    const shown = await readShown(page, field);
    if (shown && !shown.length) open.push(gap);
  }
  if (!open.length) return [];
  const supplied = await askHuman(applicationId, page, fillable, open);
  for (const [fieldId, answer] of supplied) {
    state.answers.set(fieldId, answer);
    ctx.sessionAnswers.set(fieldId, answer);
  }
  const asked = open.map((g) => byId.get(g.fieldId)!);
  const stillMissing = asked.filter((f) => !state.answers.has(f.id));
  if (stillMissing.length) {
    throw new Error(
      `Required field(s) left unanswered: ${stillMissing.map((f) => f.label).join(', ')}`,
    );
  }
  return asked;
}

/**
 * "If yes, please describe..." under a question this run answered No.
 *
 * Forms mark these required even though they only apply to a Yes, so they
 * were put to you after you (or your profile) had already said No.
 */
// Starts with the condition. "Do you have a non-compete? If yes, describe" is
// a question of its own, and is still asked.
const FOLLOW_UP =
  /^\W*(if (yes|so)\b|if you (answered|selected|chose|said) \W?yes\b)|^(please )?(describe|explain|specify|provide details|list|give details)\b[^?]{0,60}\bif (yes|so)\b/i;
export function followsANo(
  field: FormField,
  fields: FormField[],
  answers: Map<string, ResolvedAnswer>,
): boolean {
  if (!FOLLOW_UP.test(field.label.trim())) return false;
  // The question it hangs off is a yes/no-shaped one just before it.
  const at = fields.indexOf(field);
  for (let i = at - 1; i >= 0 && i >= at - 2; i--) {
    const prev = fields[i]!;
    const answer = answers.get(prev.id);
    const yesNo =
      prev.options?.some((o) => /^no\b/i.test(o.label.trim())) ||
      prev.kind === 'CHECKBOX' ||
      answer?.value === false;
    if (!yesNo) continue;
    if (!answer) return false;
    const shown = normalizeLabel(answer.displayValue);
    return answer.value === false || /^(no|false)\b/.test(shown);
  }
  return false;
}
