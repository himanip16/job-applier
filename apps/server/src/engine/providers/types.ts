import type { FormField, ResolvedAnswer, AnswerGap } from '@ja/shared';
import type { Profile, ProfileFact } from '../../lib/db.js';

export type Resolution =
  | { kind: 'answer'; answer: ResolvedAnswer }
  | { kind: 'gap'; gap: AnswerGap };

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
  /** Set when text generation failed, so the popup can say why. */
  essayError?: string;
}

export interface ProviderContext {
  field: FormField;
  ctx: ResolveContext;
  canonicalKey?: string;
  isSensitive: boolean;
}

export interface ProviderResult {
  kind: 'answer';
  answer: ResolvedAnswer;
}

export interface ProviderGap {
  kind: 'gap';
  gap: AnswerGap;
}

export type ProviderOutput = ProviderResult | ProviderGap | null;

/**
 * A Provider is a strategy for resolving a field value.
 * Each provider takes a field and context, and either returns an Answer, a Gap, or null.
 * If null is returned, the pipeline continues to the next provider.
 */
export interface Provider {
  name: string;
  provide(context: ProviderContext): Promise<ProviderOutput> | ProviderOutput;
}
