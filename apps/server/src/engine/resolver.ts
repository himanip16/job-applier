import {
  matchCanonical,
  getCanonical,
  type FormField,
  type ResolvedAnswer,
  type AnswerGap,
} from '@ja/shared';
import type { Profile, ProfileFact } from '../lib/db.js';
import { config } from '../lib/config.js';
import { findAnswer, noteAnswerUsed } from './answerBank.js';
import { matchOption, findDeclineOption } from './optionMatch.js';
import { inferAnswers, type Inference } from '../llm/inferAnswer.js';
import { generateEssayAnswer } from '../llm/coverLetter.js';
import { answerFromHistory, degreeLevel } from './repeatableSections.js';

export type Resolution =
  | { kind: 'answer'; answer: ResolvedAnswer }
  | { kind: 'gap'; gap: AnswerGap };

/** Everything free was tried; only the model is left. */
type NeedsModel = { kind: 'infer'; key?: string; perCompany: boolean; essayError?: string };

export interface ResolveContext {
  profile: Profile & { facts: ProfileFact[] };
  candidateContext: string;
  companyName: string;
  companyKey: string;
  jobTitle: string;
  jobDescription: string;
  /** Pre-generated cover letter, used when a form has a cover-letter textarea. */
  coverLetter?: string;
  /** Answers the human supplied earlier in this same run. */
  sessionAnswers: Map<string, ResolvedAnswer>;
}

/**
 * Decide what goes in every field on a form page.
 *
 * Each field walks the free rungs on its own; the ones that reach the model
 * are then answered together in a single call rather than one call apiece.
 */
export async function resolveFields(
  fields: FormField[],
  ctx: ResolveContext,
): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  const pending = new Map<string, NeedsModel>();
  for (const field of fields) {
    const res = await resolveWithoutModel(field, ctx);
    if (res.kind === 'infer') pending.set(field.id, res);
    else out.set(field.id, res);
  }
  if (pending.size) {
    const asked = fields.filter((f) => pending.has(f.id));
    const inferences = await inferAnswers({
      candidateContext: ctx.candidateContext,
      fields: asked,
      jobTitle: ctx.jobTitle,
      companyName: ctx.companyName,
    });
    for (const field of asked) {
      out.set(field.id, fromInference(field, inferences.get(field.id)!, pending.get(field.id)!));
    }
  }
  // Callers read the plan in form order.
  return new Map(fields.map((f) => [f.id, out.get(f.id)!]));
}

export async function resolveField(field: FormField, ctx: ResolveContext): Promise<Resolution> {
  return (await resolveFields([field], ctx)).get(field.id)!;
}

/**
 * Decide what goes in one field, short of asking the model.
 *
 * Order matters: cheap, deterministic and high-trust sources are consulted
 * before expensive or fallible ones, and the LLM is the last resort before
 * asking the human. Every branch either produces an answer with a source we
 * can show the user, or a gap that stops the run.
 */
async function resolveWithoutModel(field: FormField, ctx: ResolveContext): Promise<Resolution | NeedsModel> {
  // 0. Something the human answered a moment ago in this very run.
  const fromSession = ctx.sessionAnswers.get(field.id);
  if (fromSession) return { kind: 'answer', answer: fromSession };

  // 0b. A row of an Employment / Education section, from the matching
  //     employment.N / education.N fact the candidate saved.
  const historical = fromHistory(field, ctx);
  if (historical) return historical;

  const canonical = field.canonicalKey
    ? getCanonical(field.canonicalKey)
    : matchCanonical(field.label);
  const key = canonical?.key;
  /** Set when text generation failed, so the popup can say why. */
  let essayError: string | undefined;

  // 1. Structured profile data. No ambiguity, no cost.
  const direct = fromProfile(key, ctx.profile);
  if (direct !== null) {
    const shaped = shapeForField(direct, field);
    if (shaped) {
      return {
        kind: 'answer',
        answer: {
          fieldId: field.id,
          value: shaped.value,
          displayValue: shaped.display,
          source: 'PROFILE',
          confidence: 1,
          rationale: `From your profile (${key}).`,
          remember: false,
          canonicalKey: key,
        },
      };
    }
  }

  // 2. Demographic / EEO. Never inferred. If the candidate has explicitly
  //    recorded an answer we use it; otherwise we take the form's own
  //    "decline to self-identify" option, which is a real, legitimate answer
  //    rather than a guess about someone's identity.
  if (canonical?.sensitive || field.sensitive) {
    const stated = ctx.profile.facts.find((f) => f.key === key);
    if (stated) {
      const shaped = shapeForField(stated.value, field);
      if (shaped) {
        return {
          kind: 'answer',
          answer: {
            fieldId: field.id,
            value: shaped.value,
            displayValue: shaped.display,
            source: 'PROFILE',
            confidence: 1,
            rationale: 'You recorded this answer yourself.',
            remember: false,
            canonicalKey: key,
          },
        };
      }
    }
    const decline = findDeclineOption(field.options);
    if (decline) {
      return {
        kind: 'answer',
        answer: {
          fieldId: field.id,
          value: decline.value ?? decline.label,
          displayValue: decline.label,
          source: 'SKIPPED',
          confidence: 1,
          rationale: 'Demographic question: defaulted to decline to self-identify.',
          remember: false,
          canonicalKey: key,
        },
      };
    }
    if (!field.required) {
      return {
        kind: 'answer',
        answer: {
          fieldId: field.id,
          value: null,
          displayValue: '',
          source: 'SKIPPED',
          confidence: 1,
          rationale: 'Optional demographic question, left blank.',
          remember: false,
          canonicalKey: key,
        },
      };
    }
    return {
      kind: 'gap',
      gap: {
        fieldId: field.id,
        reason: 'POLICY',
        suggestion: null,
        suggestionRationale:
          'This is a demographic question. It is never answered automatically - tell us what you want submitted, or leave it blank.',
      },
    };
  }

  // 3. A stored fact under a recognised canonical key.
  if (key) {
    const fact = ctx.profile.facts.find((f) => f.key === key);
    if (fact) {
      const shaped = shapeForField(fact.value, field);
      if (shaped) {
        return {
          kind: 'answer',
          answer: {
            fieldId: field.id,
            value: shaped.value,
            displayValue: shaped.display,
            source: 'RULE',
            confidence: 1,
            rationale: `You told us: ${fact.label} = ${fact.value}`,
            remember: false,
            canonicalKey: key,
          },
        };
      }
    }
  }

  // 4. Company-specific free text. Generated fresh every time, never recycled
  //    across employers - a "why do you want to work here" answer written for
  //    one company is worse than useless at the next one. Only when the form
  //    insists: an optional essay is a model call nobody asked for.
  if ((canonical?.perCompany || isEssayField(field)) && field.required) {
    if (key === 'essay.cover_letter' && ctx.coverLetter) {
      return {
        kind: 'answer',
        answer: {
          fieldId: field.id,
          value: ctx.coverLetter,
          displayValue: ctx.coverLetter,
          source: 'GENERATED',
          confidence: 0.9,
          rationale: 'Cover letter generated for this role.',
          remember: false,
          canonicalKey: key,
        },
      };
    }
    // A failure here (no API key, rate limit, network) must not sink the run.
    // Falling through turns it into a question for the human, which is the
    // same outcome as the model declining to answer.
    let text = '';
    try {
      text = await generateEssayAnswer({
        candidateContext: ctx.candidateContext,
        companyName: ctx.companyName,
        jobTitle: ctx.jobTitle,
        jobDescription: ctx.jobDescription,
        question: field.label,
        maxChars: field.kind === 'TEXTAREA' ? 1400 : 400,
      });
    } catch (err) {
      essayError = (err as Error).message;
    }
    if (text.trim()) {
      return {
        kind: 'answer',
        answer: {
          fieldId: field.id,
          value: text,
          displayValue: text,
          source: 'GENERATED',
          confidence: 0.8,
          rationale: 'Written for this specific job from your resume and the job description.',
          remember: false,
          canonicalKey: key,
        },
      };
    }
  }

  // 5. The answer bank: something you already answered, here or elsewhere.
  const remembered = await findAnswer({
    profileId: ctx.profile.id,
    canonicalKey: key,
    label: field.label,
    options: field.options,
    companyKey: ctx.companyKey,
    threshold: config.memoryReuseThreshold,
  });
  if (remembered) {
    // Use the structured value, not the joined display string: a remembered
    // multi-select is ["Go","TypeScript"], and collapsing that to
    // "Go, TypeScript" makes it unmappable onto the new form's options.
    const stored = remembered.answer.value;
    const usable: string | string[] =
      Array.isArray(stored) && stored.every((v) => typeof v === 'string')
        ? (stored as string[])
        : remembered.answer.displayValue;
    const shaped = shapeForField(usable, field);
    if (shaped) {
      await noteAnswerUsed(remembered.answer.id);
      return {
        kind: 'answer',
        answer: {
          fieldId: field.id,
          value: shaped.value,
          displayValue: shaped.display,
          source: remembered.how === 'FUZZY' ? 'MEMORY_FUZZY' : 'MEMORY_EXACT',
          confidence: remembered.how === 'FUZZY' ? remembered.similarity : 1,
          rationale:
            remembered.how === 'FUZZY'
              ? `Reused your answer to a near-identical question: "${remembered.answer.rawLabel}"`
              : `Reused your saved answer to "${remembered.answer.rawLabel}"`,
          remember: false,
          canonicalKey: key,
        },
      };
    }
  }

  // 6. Ask the model - but only to *derive*, never to invent. Batched by the caller.
  //    Optional fields still come here: boards mark "required" with a styled
  //    asterisk often enough that the flag cannot be trusted to mean blank is fine.
  return { kind: 'infer', key, perCompany: Boolean(canonical?.perCompany), essayError };
}

function fromInference(field: FormField, inference: Inference, pending: NeedsModel): Resolution {
  const { key, essayError } = pending;
  if (inference.answerable && inference.confidence >= config.answerConfidenceThreshold) {
    const raw = inference.values.length ? inference.values : inference.value;
    const shaped = shapeForField(raw, field);
    if (shaped) {
      return {
        kind: 'answer',
        answer: {
          fieldId: field.id,
          value: shaped.value,
          displayValue: shaped.display,
          source: 'INFERRED',
          confidence: inference.confidence,
          rationale: inference.evidence || 'Derived from your resume.',
          // Worth keeping: next time this is a free memory hit rather than a
          // paid inference. Only for recognised, reusable questions.
          remember: Boolean(key) && !pending.perCompany,
          canonicalKey: key,
        },
      };
    }
  }

  // 7. Out of options. Stop and ask.
  const suggestion =
    inference.values.length > 0
      ? inference.values
      : inference.value
        ? inference.value
        : null;
  return {
    kind: 'gap',
    gap: {
      fieldId: field.id,
      reason: inference.answerable ? 'LOW_CONFIDENCE' : 'NO_MATCH',
      suggestion,
      suggestionRationale:
        essayError ||
        inference.missingInformation ||
        (inference.answerable
          ? `Best guess is only ${(inference.confidence * 100).toFixed(0)}% certain, which is below the bar for submitting under your name.`
          : 'Not answerable from your profile or resume.'),
    },
  };
}

function isEssayField(field: FormField): boolean {
  return (
    field.kind === 'TEXTAREA' &&
    /\bwhy\b|motivat|interest|excite|tell us|describe|what (makes|draws)/i.test(field.label)
  );
}

/** Pull an answer straight off the structured profile record. */
function fromProfile(key: string | undefined, p: Profile): string | null {
  switch (key) {
    case 'identity.first_name': return p.firstName;
    case 'identity.last_name': return p.lastName;
    case 'identity.full_name': return p.fullName;
    case 'identity.preferred_name': return p.firstName;
    case 'contact.email': return p.email;
    case 'contact.phone': return p.phone;
    case 'contact.linkedin': return p.linkedin;
    case 'contact.github': return p.github;
    case 'contact.website': return p.website ?? p.portfolio;
    case 'location.country': return p.country;
    case 'location.city': return p.city;
    case 'location.current':
      return [p.city, p.region, p.country].filter(Boolean).join(', ') || null;
    default: return null;
  }
}

/**
 * Turn a desired answer into something this specific control can accept.
 * Returns null when the value cannot be represented, which pushes the caller
 * on to the next strategy (and ultimately to asking the human).
 */
function shapeForField(
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

/**
 * "Employment 2: Company name" and friends, answered from the candidate's
 * own saved work history. Null sends the field down the ordinary path.
 */
function fromHistory(field: FormField, ctx: ResolveContext): Resolution | null {
  const raw = answerFromHistory(field, ctx.profile.facts);
  if (raw === null) return null;
  const answer = (value: string | string[] | null, display: string, rationale: string): Resolution => ({
    kind: 'answer',
    answer: {
      fieldId: field.id,
      value,
      displayValue: display,
      source: value === null ? 'SKIPPED' : 'PROFILE',
      confidence: 1,
      rationale,
      remember: false,
    },
  });
  const row = field.label.replace(/:.*$/, '');

  if (raw === '') return answer(null, '', `${row} is your current role, so it has no end date.`);
  if (typeof raw === 'boolean') {
    if (field.kind === 'CHECKBOX_GROUP') {
      const box = field.options?.[0]?.label;
      return raw && box ? answer([box], box, `From your saved ${row}.`) : answer(null, '', `${row} is not your current role.`);
    }
    return answer(raw ? 'true' : 'false', raw ? 'Yes' : 'No', `From your saved ${row}.`);
  }

  const shaped =
    shapeForField(raw, field) ??
    (/degree/i.test(field.label) && degreeLevel(raw) ? shapeForField(degreeLevel(raw), field) : null);
  if (shaped) return answer(shaped.value, shaped.display, `From your saved ${row}.`);
  // A searchable dropdown (Greenhouse's School) only shows a slice of its
  // options until you type, so a miss in the harvested list is not a miss.
  // Typing the name either finds it or fails the fill, which then asks you.
  if (field.widget === 'react-select' && /school|university|college|institution/i.test(field.label)) {
    return answer(raw, raw, `From your saved ${row}.`);
  }
  return null;
}
