import { z } from 'zod';

/** Every kind of input we know how to drive. */
export const FieldKind = z.enum([
  'TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'URL', 'NUMBER', 'DATE',
  'SELECT', 'MULTISELECT', 'RADIO', 'CHECKBOX', 'CHECKBOX_GROUP',
  'FILE', 'UNKNOWN',
]);
export type FieldKind = z.infer<typeof FieldKind>;

export const FieldOption = z.object({
  /** What the user sees. */
  label: z.string(),
  /** What the DOM wants, when it differs (native <option value>). */
  value: z.string().optional(),
});
export type FieldOption = z.infer<typeof FieldOption>;

/**
 * A single form control, described independently of how it is rendered.
 * Adapters produce these; the fill engine consumes them.
 */
export const FormField = z.object({
  /** Stable id we use to address the field across the run. */
  id: z.string(),
  /** Playwright selector that resolves to the control (or its combobox input). */
  selector: z.string(),
  /**
   * The control's own `name` (or `id`), when it has one.
   *
   * `id` and `selector` are stamped onto the element at extraction time, so
   * both die the moment anything re-renders. This survives, which is what
   * lets a field be found again afterwards — and it disambiguates the very
   * common case of two controls sharing a label, such as Greenhouse's phone
   * block, where "Phone" is both the dial-code group and the number.
   */
  name: z.string().optional(),
  kind: FieldKind,
  label: z.string(),
  helpText: z.string().optional(),
  required: z.boolean().default(false),
  options: z.array(FieldOption).optional(),
  /**
   * How the control must be driven. `native` = standard HTML semantics,
   * `react-select` = click/type/pick from a portal listbox, etc.
   */
  widget: z.enum(['native', 'react-select', 'radio-group', 'checkbox-group', 'file', 'combobox-intl-tel']).default('native'),
  /** Extra selector for widgets whose options render outside the control. */
  optionContainerSelector: z.string().optional(),
  /** Set when the adapter recognised this as a well-known field. */
  canonicalKey: z.string().optional(),
  /** True for demographic/EEO questions — never inferred, always optional. */
  sensitive: z.boolean().default(false),
});
export type FormField = z.infer<typeof FormField>;

export const ResolutionSource = z.enum([
  'PROFILE',      // straight from structured profile data
  'RULE',         // deterministic canonical-key rule + stored fact
  'MEMORY_EXACT', // same normalised label answered before
  'MEMORY_FUZZY', // semantically similar label answered before
  'GENERATED',    // essay/cover-letter style, written fresh for this job
  'INFERRED',     // LLM derived it from profile + resume
  'USER',         // a human just answered the popup
  'SKIPPED',      // optional + sensitive, deliberately left blank
]);
export type ResolutionSource = z.infer<typeof ResolutionSource>;

export const ResolvedAnswer = z.object({
  fieldId: z.string(),
  /** Machine value: string | string[] | boolean | number. */
  value: z.union([z.string(), z.array(z.string()), z.boolean(), z.number(), z.null()]),
  /** Exactly what will be typed or picked. */
  displayValue: z.string(),
  source: ResolutionSource,
  confidence: z.number().min(0).max(1),
  rationale: z.string().optional(),
  /** Persist to the answer bank after a successful submit. */
  remember: z.boolean().default(false),
  canonicalKey: z.string().optional(),
});
export type ResolvedAnswer = z.infer<typeof ResolvedAnswer>;

/** What the resolver returns when it refuses to guess. */
export const AnswerGap = z.object({
  fieldId: z.string(),
  reason: z.enum(['NO_MATCH', 'LOW_CONFIDENCE', 'POLICY']),
  /** Best guess offered as a prefill — the human accepts or overrides. */
  suggestion: z.union([z.string(), z.array(z.string()), z.null()]).nullable(),
  suggestionRationale: z.string().optional(),
});
export type AnswerGap = z.infer<typeof AnswerGap>;

export const AppStatus = z.enum([
  'QUEUED', 'PREPARING', 'FILLING', 'NEEDS_INPUT', 'NEEDS_HUMAN',
  'REVIEW', 'SUBMITTING', 'SUBMITTED', 'FAILED', 'CANCELLED',
]);
export type AppStatus = z.infer<typeof AppStatus>;

/** Things that stop a run dead and need a human at the keyboard. */
export const BlockerKind = z.enum([
  'CAPTCHA', 'LOGIN_REQUIRED', 'ACCOUNT_CREATION', 'EMAIL_VERIFICATION',
  'FILE_UPLOAD_UNSUPPORTED', 'ASSESSMENT', 'UNKNOWN',
]);
export type BlockerKind = z.infer<typeof BlockerKind>;

export const RunEvent = z.object({
  applicationId: z.string(),
  type: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
  at: z.string(),
});
export type RunEvent = z.infer<typeof RunEvent>;
