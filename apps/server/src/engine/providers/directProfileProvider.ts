import type { Provider, ProviderContext, ProviderOutput } from './types.js';
import type { Profile } from '../../lib/db.js';
import { shapeForField } from './fieldShaper.js';

/**
 * Pull an answer straight off the structured profile record.
 * Maps canonical keys to specific database columns on the Profile model.
 */
function fromProfile(key: string | undefined, p: Profile): string | null {
  switch (key) {
    case 'identity.first_name': return p.firstName;
    case 'identity.last_name': return p.lastName;
    case 'identity.full_name': return p.fullName;
    case 'contact.email': return p.email;
    case 'contact.phone': return p.phone;
    case 'contact.linkedin': return p.linkedin;
    case 'contact.github': return p.github;
    case 'contact.website': return p.website ?? p.portfolio;
    case 'location.country': return p.country;
    case 'location.current':
      return [p.city, p.region, p.country].filter(Boolean).join(', ') || null;
    default: return null;
  }
}

/**
 * DirectProfileProvider extracts structured profile data.
 * No ambiguity, no cost - this is the second highest priority after session.
 */
export const DirectProfileProvider: Provider = {
  name: 'DirectProfileProvider',
  provide(context: ProviderContext): ProviderOutput {
    const { field, ctx, canonicalKey } = context;
    const direct = fromProfile(canonicalKey, ctx.profile);
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
            rationale: `From your profile (${canonicalKey}).`,
            remember: false,
            canonicalKey: canonicalKey,
          },
        };
      }
    }
    return null;
  },
};
