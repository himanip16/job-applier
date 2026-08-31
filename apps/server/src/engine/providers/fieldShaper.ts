import type { FormField } from '@ja/shared';
import { matchOption } from '../optionMatch.js';

/**
 * Turn a desired answer into something this specific control can accept.
 * Returns null when the value cannot be represented, which pushes the caller
 * on to the next strategy (and ultimately to asking the human).
 */
export function shapeForField(
  raw: string | string[] | null,
  field: FormField,
): { value: string | string[]; display: string } | null {
  if (raw === null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.every((v) => !v?.trim())) return null;

  const needsOption =
    field.kind === 'SELECT' ||
    field.kind === 'MULTISELECT' ||
    field.kind === 'RADIO' ||
    field.kind === 'CHECKBOX_GROUP';

  if (!needsOption || !field.options?.length) {
    const text = list.join(', ');
    return { value: Array.isArray(raw) ? list : text, display: text };
  }

  const picked: string[] = [];
  for (const want of list) {
    const m = matchOption(want, field.options);
    // 0.7 is the point below which the match is a guess rather than a mapping.
    if (!m || m.score < 0.7) return null;
    picked.push(m.option.label);
  }
  const multi = field.kind === 'MULTISELECT' || field.kind === 'CHECKBOX_GROUP';
  return multi
    ? { value: picked, display: picked.join(', ') }
    : { value: picked[0]!, display: picked[0]! };
}
