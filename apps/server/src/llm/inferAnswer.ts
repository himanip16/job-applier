import { z } from 'zod';
import { generate, describeLlmError } from './client.js';
import type { FormField } from '@ja/shared';

/**
 * The contract that makes "don't assume" real.
 *
 * `answerable` is the model's judgement on whether the answer is *derivable*
 * from the candidate context. The prompt makes clear that plausible-sounding
 * guesses are failures, not successes: it is always correct to hand the
 * question back to the human. Everything downstream treats
 * `answerable === false` (or confidence under the threshold) as a hard stop.
 */
const InferenceSchema = z.object({
  answerable: z
    .boolean()
    .describe(
      'True ONLY if the answer is stated in, or unambiguously implied by, the candidate context. False if it requires guessing.',
    ),
  value: z
    .string()
    .describe(
      'The answer. For a select/radio field this MUST be one of the provided option labels, copied exactly. Empty string when answerable is false.',
    ),
  /** Multi-select answers come back here instead. */
  values: z
    .array(z.string())
    .describe('For multi-select fields only: the chosen option labels, copied exactly. Otherwise an empty array.'),
  confidence: z
    .number()
    .describe('0.0-1.0. How certain you are that this is what the candidate would actually answer.'),
  evidence: z
    .string()
    .describe('The specific line(s) from the candidate context that support this answer. Empty when answerable is false.'),
  missingInformation: z
    .string()
    .describe('When answerable is false: precisely what the candidate needs to tell you. Otherwise empty.'),
});

export type Inference = z.infer<typeof InferenceSchema>;

const SYSTEM = `You fill in job application forms on behalf of a candidate. The application is submitted under the candidate's own name and they are legally accountable for every answer.

Your single most important rule: NEVER INVENT AN ANSWER.

You are given the candidate's profile, stated facts, and resume. If the answer to a question is contained there, or follows unambiguously from it, answer. Otherwise set answerable=false and say what is missing. A question handed back to the human costs them five seconds. A fabricated answer can cost them the job or expose them to a claim of misrepresentation.

Specific rules:
- Salary expectations, notice period, start date, visa specifics, security clearances, willingness to relocate, years of experience in a named technology: answer ONLY if explicitly stated. Do not estimate, do not average, do not infer from job titles or dates unless the arithmetic is exact and unambiguous.
- Never infer demographic information (gender, race, ethnicity, disability, veteran status, sexual orientation, age). Always answerable=false for these, with no exceptions.
- For a select, radio or multi-select field, your answer must be an exact copy of one of the supplied option labels. If none of the options fits what the candidate actually is, set answerable=false rather than picking the closest one.
- Yes/no questions still need evidence. "Probably yes" is answerable=false.
- If the question asks for an opinion, motivation, or free-form essay about this specific employer, set answerable=false — those are handled separately, not by you.
- confidence reflects certainty about the candidate's true answer, not fluency of your guess. Be harsh with it.`;

export interface InferAnswerInput {
  candidateContext: string;
  field: FormField;
  jobTitle: string;
  companyName: string;
}

export async function inferAnswer(input: InferAnswerInput): Promise<Inference> {
  const { field } = input;
  const optionBlock = field.options?.length
    ? `\n<options>\n${field.options.map((o) => `- ${o.label}`).join('\n')}\n</options>`
    : '';

  const userContent = `${input.candidateContext}

<application>
company: ${input.companyName}
role: ${input.jobTitle}
</application>

<question>
label: ${field.label}
${field.helpText ? `help_text: ${field.helpText}\n` : ''}input_type: ${field.kind}
required: ${field.required}${optionBlock}
</question>

Answer the question above using only the candidate context.`;

  try {
    const parsed = await generate({
      task: 'answerInference',
      system: SYSTEM,
      prompt: userContent,
      schema: InferenceSchema,
      maxTokens: 2000,
    });

    if (!parsed) {
      return blank('The model returned no parseable answer.');
    }
    return checkOptions(parsed, field);
  } catch (err) {
    return blank(describeLlmError(err));
  }
}

const BatchSchema = z.object({
  answers: z.array(InferenceSchema.extend({ id: z.string().describe('The question id, copied exactly.') })),
});

export interface InferAnswersInput extends Omit<InferAnswerInput, 'field'> {
  fields: FormField[];
}

/**
 * Every question on a form page that needs the model, in one call.
 *
 * Asking per field sent the whole candidate context once per question - a
 * page with six unknowns paid for the resume six times and waited on six
 * round trips. The rules are the same; only the envelope changes. A single
 * field goes through `inferAnswer` unchanged.
 */
export async function inferAnswers(input: InferAnswersInput): Promise<Map<string, Inference>> {
  const { fields, ...rest } = input;
  const out = new Map<string, Inference>();
  if (!fields.length) return out;
  if (fields.length === 1) {
    out.set(fields[0]!.id, await inferAnswer({ ...rest, field: fields[0]! }));
    return out;
  }

  // Short ids: field handles can be long selectors, and the model must copy them back.
  const byRef = new Map(fields.map((f, i) => [`q${i + 1}`, f]));
  const questions = [...byRef]
    .map(([ref, f]) => {
      const options = f.options?.length
        ? `\n<options>\n${f.options.map((o) => `- ${o.label}`).join('\n')}\n</options>`
        : '';
      return `<question id="${ref}">
label: ${f.label}
${f.helpText ? `help_text: ${f.helpText}\n` : ''}input_type: ${f.kind}
required: ${f.required}${options}
</question>`;
    })
    .join('\n\n');

  const prompt = `${rest.candidateContext}

<application>
company: ${rest.companyName}
role: ${rest.jobTitle}
</application>

${questions}

Answer each question above independently, using only the candidate context. Return exactly one entry per question id.`;

  let parsed: z.infer<typeof BatchSchema> | null = null;
  let failure = 'The model returned no parseable answer.';
  try {
    parsed = await generate({
      task: 'answerInference',
      system: SYSTEM,
      prompt,
      schema: BatchSchema,
      maxTokens: 800 + 400 * fields.length,
    });
  } catch (err) {
    failure = describeLlmError(err);
  }

  const returned = new Map((parsed?.answers ?? []).map((a) => [a.id.trim(), a]));
  for (const [ref, field] of byRef) {
    const answer = returned.get(ref);
    if (!answer) {
      out.set(field.id, blank(parsed ? 'The model skipped this question.' : failure));
      continue;
    }
    const { id: _id, ...inference } = answer;
    out.set(field.id, checkOptions(inference, field));
  }
  return out;
}

/** Even if the model claims an option, verify it exists. */
function checkOptions(parsed: Inference, field: FormField): Inference {
  if (parsed.answerable && field.options?.length) {
    const valid = new Set(field.options.map((o) => o.label.trim().toLowerCase()));
    const claimed = parsed.values.length ? parsed.values : [parsed.value];
    const bad = claimed.filter((v: string) => v && !valid.has(v.trim().toLowerCase()));
    if (bad.length) {
      return blank(`Model proposed option(s) that are not on the form: ${bad.join(', ')}`);
    }
  }
  return parsed;
}

function blank(reason: string): Inference {
  return {
    answerable: false,
    value: '',
    values: [],
    confidence: 0,
    evidence: '',
    missingInformation: reason,
  };
}
