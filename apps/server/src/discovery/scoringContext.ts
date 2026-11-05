import { prisma } from '../lib/db.js';
import { candidateConstraints } from './hardRules.js';
import { buildVocabulary } from './featureExtraction.js';
import { loadSignals } from './signalLearning.js';
import type { ScoringContext as LexicalScoringContext } from './lexicalScoring.js';

/**
 * Everything the cheap pass needs, loaded once per crawl rather than per job.
 */
export interface ScoringContext extends LexicalScoringContext {}

/**
 * Load the scoring context for a profile, including signals, vocabulary,
 * and profile characteristics.
 */
export async function loadScoringContext(profileId: string): Promise<ScoringContext> {
  const [signals, profile] = await Promise.all([
    loadSignals(profileId),
    prisma.profile.findUnique({ where: { id: profileId }, include: { facts: true } }),
  ]);
  const vocabulary: Set<string> = profile ? buildVocabulary(profile) : new Set();
  const text = `${profile?.resumeText ?? ''}\n${profile?.summary ?? ''}`;
  return {
    signals,
    vocabulary,
    technical: /\b(software|backend|back-end|frontend|full[- ]?stack|engineer|developer|sde)\b/i.test(text),
    backend: /\bback[- ]?end\b/i.test(text),
    candidateYears: profile ? candidateConstraints(profile).candidateYears : null,
  };
}
