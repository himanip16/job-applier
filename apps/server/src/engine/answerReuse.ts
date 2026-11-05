import { normalizeLabel, type FormField, type ResolvedAnswer } from '@ja/shared';
import { prisma } from '../lib/db.js';

/**
 * Answers given to this application on an earlier run that did not finish.
 *
 * The run most likely to need restarting is the one where you have just typed
 * two dozen answers and the tab then closed; asking all of them again is the
 * worst possible response to that.
 */
export async function answersFromEarlierRuns(
  applicationId: string,
): Promise<Map<string, { label: string; value: string | string[]; remember: boolean }>> {
  const answered = await prisma.pendingQuestion.findMany({
    where: { applicationId, answeredAt: { not: null } },
    orderBy: { answeredAt: 'asc' },
  });
  const out = new Map<string, { label: string; value: string | string[]; remember: boolean }>();
  for (const q of answered) {
    const v = q.answerValue;
    if (typeof v !== 'string' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) continue;
    out.set(q.fieldId, { label: normalizeLabel(q.rawLabel), value: v as string | string[], remember: q.remember });
  }
  return out;
}

/**
 * Move this step's answers onto the handles of a fresh read of the same step.
 *
 * A step is read again after a pause (state.step is wound back), and handles
 * are positional: when the page re-renders with one control more or fewer,
 * every handle after it shifts. Answers were looked up by handle alone, so on
 * Microsoft's contact page the dial code landed in "Alternate Phone Number",
 * the phone number in "Address" and the country in "Postal Code/Zip". Answers
 * now follow the question, and a handle's old answer never outlives it.
 */
export function rekeyRereadStep(
  fields: FormField[],
  state: { step: number; allFields: FormField[]; answers: Map<string, ResolvedAnswer> },
  sessionAnswers: Map<string, ResolvedAnswer>,
): void {
  const prefix = `s${state.step}:`;
  const question = (f: FormField) => `${f.kind}:${normalizeLabel(f.label)}`;
  // Only the latest read of each handle owns what is stored under it.
  const byQuestion = new Map<string, ResolvedAnswer>();
  const seen = new Set<string>();
  for (const f of [...state.allFields].reverse()) {
    if (!f.id.startsWith(prefix) || seen.has(f.id)) continue;
    seen.add(f.id);
    const answer = sessionAnswers.get(f.id);
    if (answer && !byQuestion.has(question(f))) byQuestion.set(question(f), answer);
  }
  if (!seen.size) return;
  for (const id of seen) {
    sessionAnswers.delete(id);
    state.answers.delete(id);
  }
  for (const f of fields) {
    const answer = byQuestion.get(question(f));
    if (answer) sessionAnswers.set(f.id, { ...answer, fieldId: f.id });
  }
}

/**
 * Reuse an earlier reply for a field on this screen - only when it is the same
 * handle AND the same question, since handles are positional and a form that
 * changed between runs would otherwise put an answer in the wrong box.
 */
export function carryOverEarlierReplies(
  fields: FormField[],
  earlier: Map<string, { label: string; value: string | string[]; remember: boolean }>,
  sessionAnswers: Map<string, ResolvedAnswer>,
): void {
  for (const field of fields) {
    const prior = earlier.get(field.id);
    if (!prior || prior.label !== normalizeLabel(field.label) || sessionAnswers.has(field.id)) continue;
    sessionAnswers.set(field.id, {
      fieldId: field.id,
      value: prior.value,
      displayValue: Array.isArray(prior.value) ? prior.value.join(', ') : prior.value,
      source: 'USER',
      confidence: 1,
      rationale: 'You answered this on an earlier attempt.',
      remember: prior.remember,
      canonicalKey: field.canonicalKey,
    });
  }
}
