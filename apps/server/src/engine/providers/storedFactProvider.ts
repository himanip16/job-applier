import type { Provider, ProviderContext, ProviderOutput } from './types.js';
import { shapeForField } from './fieldShaper.js';

/**
 * StoredFactProvider looks for stored facts under recognized canonical keys.
 * These are facts the user has explicitly told us, separate from structured profile data.
 */
export const StoredFactProvider: Provider = {
  name: 'StoredFactProvider',
  provide(context: ProviderContext): ProviderOutput {
    const { field, ctx, canonicalKey } = context;

    if (!canonicalKey) {
      return null;
    }

    const fact = ctx.profile.facts.find((f) => f.key === canonicalKey);
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
            canonicalKey: canonicalKey,
          },
        };
      }
    }

    return null;
  },
};
