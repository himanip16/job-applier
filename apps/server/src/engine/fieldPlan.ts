import type { FormField, ResolvedAnswer } from '@ja/shared';

/**
 * The audit trail.
 *
 * One row per control the run touched, recording what went in, where the
 * value came from and whether the page kept it. This is what the review
 * screen shows and what proves, afterwards, exactly what was submitted under
 * your name - so it is written even for fields that were skipped or failed.
 */
export interface FieldPlanEntry {
  fieldId: string;
  label: string;
  kind: FormField['kind'];
  required: boolean;
  value: string | string[] | null;
  source: string;
  confidence: number;
  rationale?: string;
  filled: boolean;
  verified?: string;
  error?: string;
}

export function entry(field: FormField, answer: ResolvedAnswer | undefined, filled: boolean): FieldPlanEntry {
  return {
    fieldId: field.id,
    label: field.label,
    kind: field.kind,
    required: field.required,
    value: (answer?.value ?? null) as string | string[] | null,
    source: answer?.source ?? 'SKIPPED',
    confidence: answer?.confidence ?? 0,
    rationale: answer?.rationale,
    filled,
  };
}