import type { Provider, ProviderContext, ProviderOutput } from './types.js';
import { shapeForField } from './fieldShaper.js';
import { inferAnswer } from '../../llm/inferAnswer.js';
import { config } from '../../lib/config.js';

/**
 * LlmInferenceProvider asks the model to derive answers from the resume.
 * 
 * Policy: Only to *derive*, never to invent. The model is used as a last resort
 * before asking the human, and only when confidence meets the threshold.
 */
export const LlmInferenceProvider: Provider = {
  name: 'LlmInferenceProvider',
  async provide(context: ProviderContext): Promise<ProviderOutput> {
    const { field, ctx, canonicalKey } = context;

    const inference = await inferAnswer({
      candidateContext: ctx.candidateContext,
      field,
      jobTitle: ctx.jobTitle,
      companyName: ctx.companyName,
    });

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
            remember: true, // ALWAYS remember inferred answers for future job applications
            canonicalKey: canonicalKey,
          },
        };
      }
    }

    // If we got here, the inference either failed or was below threshold.
    // Return a gap with the inference results as suggestions.
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
          ctx.essayError ||
          inference.missingInformation ||
          (inference.answerable
            ? `Best guess is only ${(inference.confidence * 100).toFixed(0)}% certain, which is below the bar for submitting under your name.`
            : 'Not answerable from your profile or resume.'),
      },
    };
  },
};
