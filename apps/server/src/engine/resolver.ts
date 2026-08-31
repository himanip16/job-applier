import {
  matchCanonical,
  getCanonical,
  type FormField,
  type ResolvedAnswer,
  type AnswerGap,
} from '@ja/shared';
import type { Profile, ProfileFact } from '../lib/db.js';
import type {
  Provider,
  ProviderContext,
  ResolveContext as ProviderResolveContext,
  Resolution,
} from './providers/index.js';
import {
  SessionProvider,
  DirectProfileProvider,
  DemographicPolicyProvider,
  StoredFactProvider,
  AnswerBankProvider,
  EssayGeneratorProvider,
  LlmInferenceProvider,
} from './providers/index.js';
import { inferBatchAnswers } from '../llm/inferAnswer.js';
import { shapeForField } from './providers/fieldShaper.js';
import { config } from '../lib/config.js';

// Re-export types for backward compatibility
export type { Resolution };
export interface ResolveContext extends ProviderResolveContext {}

/**
 * Execute a pipeline of providers to resolve a field.
 * The pipeline stops at the first provider that returns a non-null result.
 */
async function executePipeline(
  field: FormField,
  ctx: ResolveContext,
  providers: Provider[],
): Promise<Resolution> {
  const canonical = field.canonicalKey
    ? getCanonical(field.canonicalKey)
    : matchCanonical(field.label);
  const canonicalKey = canonical?.key;
  const isSensitive = canonical?.sensitive || field.sensitive;

  const providerContext: ProviderContext = {
    field,
    ctx,
    canonicalKey,
    isSensitive,
  };

  for (const provider of providers) {
    const result = await provider.provide(providerContext);
    if (result !== null) {
      // If it's a gap, return it immediately (provider decided to stop)
      if (result.kind === 'gap') {
        return result;
      }
      // If it's an answer, return it
      return result;
    }
  }

  // If all providers returned null, return a generic gap
  return {
    kind: 'gap',
    gap: {
      fieldId: field.id,
      reason: 'NO_MATCH',
      suggestion: null,
      suggestionRationale: 'No provider could resolve this field.',
    },
  };
}

// Provider chains for different resolution strategies
const FAST_CHAIN: Provider[] = [
  SessionProvider,
  DirectProfileProvider,
  DemographicPolicyProvider,
  StoredFactProvider,
  AnswerBankProvider,
];

const FULL_CHAIN: Provider[] = [
  SessionProvider,
  DirectProfileProvider,
  DemographicPolicyProvider,
  StoredFactProvider,
  EssayGeneratorProvider,
  AnswerBankProvider,
  LlmInferenceProvider,
];

/**
 * Fast resolution that only uses profile and answer bank (no LLM calls).
 * Used in Hybrid Direct Flow for immediate filling of known fields.
 */
export async function resolveFieldFast(field: FormField, ctx: ResolveContext): Promise<Resolution> {
  return executePipeline(field, ctx, FAST_CHAIN);
}

/**
 * Decide what goes in one field.
 *
 * Order matters: cheap, deterministic and high-trust sources are consulted
 * before expensive or fallible ones, and the LLM is the last resort before
 * asking the human. Every branch either produces an answer with a source we
 * can show the user, or a gap that stops the run.
 */
export async function resolveField(field: FormField, ctx: ResolveContext): Promise<Resolution> {
  return executePipeline(field, ctx, FULL_CHAIN);
}

/**
 * Batch resolution: resolve multiple fields with a single LLM call.
 * 
 * This function first tries fast resolution (profile, answer bank) for all fields.
 * For fields that can't be resolved fast, it makes a single batch LLM call
 * instead of individual calls per field.
 * 
 * Returns a map of field ID to resolution.
 */
export async function resolveFieldsBatch(
  fields: FormField[],
  ctx: ResolveContext,
): Promise<Map<string, Resolution>> {
  const results = new Map<string, Resolution>();
  const fieldsNeedingLlm: FormField[] = [];

  // First pass: try fast resolution for all fields
  for (const field of fields) {
    const canonical = field.canonicalKey
      ? getCanonical(field.canonicalKey)
      : matchCanonical(field.label);
    const canonicalKey = canonical?.key;
    const isSensitive = canonical?.sensitive || field.sensitive;

    const providerContext: ProviderContext = {
      field,
      ctx,
      canonicalKey,
      isSensitive,
    };

    // Try fast chain (no LLM)
    let resolved = false;
    for (const provider of FAST_CHAIN) {
      const result = await provider.provide(providerContext);
      if (result !== null) {
        results.set(field.id, result);
        resolved = true;
        break;
      }
    }

    // If not resolved by fast chain, add to LLM batch
    if (!resolved) {
      fieldsNeedingLlm.push(field);
    }
  }

  // Second pass: batch LLM inference for remaining fields
  if (fieldsNeedingLlm.length > 0) {
    const batchInferences = await inferBatchAnswers({
      candidateContext: ctx.candidateContext,
      fields: fieldsNeedingLlm,
      jobTitle: ctx.jobTitle,
      companyName: ctx.companyName,
    });

    // Process batch inference results
    for (const field of fieldsNeedingLlm) {
      const inference = batchInferences.get(field.id);
      if (!inference) {
        results.set(field.id, {
          kind: 'gap',
          gap: {
            fieldId: field.id,
            reason: 'NO_MATCH',
            suggestion: null,
            suggestionRationale: 'Batch inference did not return a result for this field.',
          },
        });
        continue;
      }

      const canonical = field.canonicalKey
        ? getCanonical(field.canonicalKey)
        : matchCanonical(field.label);
      const canonicalKey = canonical?.key;
      const isSensitive = canonical?.sensitive || field.sensitive;

      // Try EssayGeneratorProvider before LLM inference (as per FULL_CHAIN order)
      const providerContext: ProviderContext = {
        field,
        ctx,
        canonicalKey,
        isSensitive,
      };

      // Check EssayGeneratorProvider first
      const essayResult = await EssayGeneratorProvider.provide(providerContext);
      if (essayResult !== null) {
        results.set(field.id, essayResult);
        continue;
      }

      // Use LLM inference result
      if (inference.answerable && inference.confidence >= config.answerConfidenceThreshold) {
        const raw = inference.values.length ? inference.values : inference.value;
        const shaped = shapeForField(raw, field);
        if (shaped) {
          results.set(field.id, {
            kind: 'answer',
            answer: {
              fieldId: field.id,
              value: shaped.value,
              displayValue: shaped.display,
              source: 'INFERRED',
              confidence: inference.confidence,
              rationale: inference.evidence || 'Derived from your resume.',
              remember: true,
              canonicalKey: canonicalKey,
            },
          });
          continue;
        }
      }

      // LLM inference failed or below threshold
      const suggestion =
        inference.values.length > 0
          ? inference.values
          : inference.value
            ? inference.value
            : null;

      results.set(field.id, {
        kind: 'gap',
        gap: {
          fieldId: field.id,
          reason: inference.answerable ? 'LOW_CONFIDENCE' : 'NO_MATCH',
          suggestion,
          suggestionRationale:
            ctx.essayError ||
            inference.missingInformation ||
            (inference.answerable
              ? `Best guess is only ${(inference.confidence * 100).toFixed(0)}% certain, which is below the bar for submitting under your name.`
              : 'Not answerable from your profile or resume.'),
        },
      });
    }
  }

  return results;
}

// Re-export isEssayField for backward compatibility
export { isEssayField } from './providers/index.js';
