import type { Provider, ProviderContext, ProviderOutput } from './types.js';
import { shapeForField } from './fieldShaper.js';
import { findAnswer, noteAnswerUsed } from '../answerBank.js';
import { config } from '../../lib/config.js';

/**
 * AnswerBankProvider looks for previously answered questions that can be reused.
 * Something the user already answered, here or elsewhere.
 */
export const AnswerBankProvider: Provider = {
  name: 'AnswerBankProvider',
  async provide(context: ProviderContext): Promise<ProviderOutput> {
    const { field, ctx, canonicalKey } = context;

    const remembered = await findAnswer({
      profileId: ctx.profile.id,
      canonicalKey: canonicalKey,
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
            canonicalKey: canonicalKey,
          },
        };
      }
    }

    return null;
  },
};
