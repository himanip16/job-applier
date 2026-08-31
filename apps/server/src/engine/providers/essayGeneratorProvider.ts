import type { Provider, ProviderContext, ProviderOutput } from './types.js';
import type { FormField } from '@ja/shared';
import { getCanonical, matchCanonical } from '@ja/shared';
import { generateEssayAnswer } from '../../llm/coverLetter.js';

/**
 * Check if a field is an essay-type field (company-specific free text).
 */
export function isEssayField(field: FormField): boolean {
  return (
    field.kind === 'TEXTAREA' &&
    /\bwhy\b|motivat|interest|excite|tell us|describe|what (makes|draws)/i.test(field.label)
  );
}

/**
 * EssayGeneratorProvider handles company-specific free text fields.
 * Generated fresh every time, never recycled across employers - a "why do you
 * want to work here" answer written for one company is worse than useless at
 * the next one.
 */
export const EssayGeneratorProvider: Provider = {
  name: 'EssayGeneratorProvider',
  async provide(context: ProviderContext): Promise<ProviderOutput> {
    const { field, ctx, canonicalKey } = context;

    // Only handle essay fields or per-company fields
    const canonical = field.canonicalKey
      ? getCanonical(field.canonicalKey)
      : matchCanonical(field.label);
    
    if (!canonical?.perCompany && !isEssayField(field)) {
      return null;
    }

    // Special case: pre-generated cover letter
    if (canonicalKey === 'essay.cover_letter' && ctx.coverLetter) {
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
          canonicalKey: canonicalKey,
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
      // Do not store error on shared context - it would pollute unrelated fields
      // Falling through to LLM inference or asking the human is the correct behavior
      return null;
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
          remember: true, // Store so re-runs for the SAME company reuse this generated essay
          canonicalKey: canonicalKey,
        },
      };
    }

    return null;
  },
};
