import type { Provider, ProviderContext, ProviderOutput } from './types.js';
import { shapeForField } from './fieldShaper.js';
import { findDeclineOption } from '../optionMatch.js';

/**
 * DemographicPolicyProvider handles EEO and sensitive demographic fields.
 * 
 * Domain Policy: Demographic questions must never be inferred by LLMs.
 * If the candidate has explicitly recorded an answer we use it; otherwise we
 * take the form's own "decline to self-identify" option, which is a real,
 * legitimate answer rather than a guess about someone's identity.
 * 
 * This provider returns a gap (not null) when it handles a sensitive field
 * but can't provide an answer, because we don't want other providers to try
 * to infer demographic information.
 */
export const DemographicPolicyProvider: Provider = {
  name: 'DemographicPolicyProvider',
  provide(context: ProviderContext): ProviderOutput {
    const { field, ctx, canonicalKey, isSensitive } = context;

    // Only handle sensitive/demographic fields
    if (!isSensitive) {
      return null;
    }

    // If the candidate has explicitly recorded an answer, use it
    const stated = ctx.profile.facts.find((f) => f.key === canonicalKey);
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
            canonicalKey: canonicalKey,
          },
        };
      }
    }

    // Try to find a decline option
    const decline = findDeclineOption(field.options);
    if (decline) {
      return {
        kind: 'answer',
        answer: {
          fieldId: field.id,
          value: decline.label ?? decline.value,
          displayValue: decline.label,
          source: 'SKIPPED',
          confidence: 1,
          rationale: 'Demographic question: defaulted to decline to self-identify.',
          remember: false,
          canonicalKey: canonicalKey,
        },
      };
    }

    // If optional, leave blank
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
          canonicalKey: canonicalKey,
        },
      };
    }

    // Required demographic field with no decline option - must ask human
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
  },
};
