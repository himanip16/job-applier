import { prisma, type Prisma } from '../lib/db.js';
import { candidateRejections } from './decisionHistory.js';
import type { LexicalScore } from './lexicalScoring.js';
import type { FitAssessment } from './modelScoring.js';

/**
 * A compact, human-readable summary of what this candidate turns down and why,
 * regenerated from the reasons they actually typed. Injected into the fit
 * prompt so the model's judgement moves with the candidate's, not just the
 * bag-of-words.
 */
export async function buildRejectionHistory(profileId: string, limit = 25): Promise<string> {
  const rejected = await prisma.jobLead.findMany({
    where: { profileId, ...candidateRejections },
    orderBy: { decidedAt: 'desc' },
    take: limit,
    select: { title: true, companyName: true, location: true, rejectReason: true, rejectCategory: true },
  });
  if (!rejected.length) return '';

  const withReasons = rejected.filter((r) => r.rejectReason);
  const lines = rejected.map((r) => {
    const where = r.location ? ` (${r.location})` : '';
    const why = r.rejectReason
      ? ` - "${r.rejectReason}"`
      : r.rejectCategory
        ? ` - ${r.rejectCategory}`
        : '';
    return `- ${r.title} at ${r.companyName}${where}${why}`;
  });

  const header =
    withReasons.length > 0
      ? `They rejected these ${rejected.length} postings; ${withReasons.length} came with a stated reason, which is the strongest signal here:`
      : `They rejected these ${rejected.length} postings without giving reasons, so infer the pattern from what they have in common:`;

  return `${header}\n${lines.join('\n')}`;
}

/**
 * What the candidate has said they want, in their own words.
 *
 * Facts, not inference: only the keys where they stated a preference, a
 * constraint or a number. This goes verbatim into the fit prompt, because a
 * stated preference outranks anything a resume implies.
 */
export async function buildPreferences(profileId: string): Promise<string> {
  const facts = await prisma.profileFact.findMany({
    where: {
      profileId,
      OR: [
        { key: { startsWith: 'preference.' } },
        { key: { startsWith: 'logistics.' } },
        { key: { startsWith: 'compensation.' } },
        { key: { startsWith: 'location.' } },
        { key: { startsWith: 'work_auth.' } },
      ],
    },
  });
  return facts.map((f) => `- ${f.label}: ${f.value}`).join('\n');
}

/**
 * Serialize scoring reasons for storage in the database.
 */
export function serialiseReasons(
  lexical: LexicalScore,
  fit: FitAssessment | null,
): Prisma.InputJsonValue {
  return {
    lexicalScore: Math.round(lexical.score),
    likedTerms: lexical.positives,
    dislikedTerms: lexical.negatives,
    // What a quick score is actually made of. Without this the only
    // explanation a keyword-ranked lead could offer was a list of learned
    // terms, which is empty until the candidate has rejected something.
    affinity: Math.round(lexical.affinity * 100),
    sharedTerms: lexical.shared,
    missingTerms: lexical.missing,
    ...(lexical.capped ? { capped: lexical.capped } : {}),
    ...(fit
      ? {
          verdict: fit.verdict,
          seniorityFit: fit.seniorityFit,
          forIt: fit.forIt,
          againstIt: fit.againstIt,
          dealbreaker: fit.dealbreaker || undefined,
        }
      : {}),
  };
}
