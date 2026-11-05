import { normalizeLabel, tokenize } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { jobTerms, countable, type ScorableJob } from './featureExtraction.js';

/**
 * Stop terms that should not be learned or counted.
 * Imported from featureExtraction to avoid duplication.
 */
const STOP_TERMS = new Set([
  'engineer', 'engineering', 'senior', 'staff', 'lead', 'principal', 'developer',
  'software', 'team', 'work', 'working', 'role', 'job', 'company', 'experience',
  'years', 'strong', 'looking', 'join', 'help', 'build', 'building', 'new',
  'not', 'no', 'nope', 'thanks', 'really', 'just', 'want', 'wanted', 'like',
  'need', 'much', 'too', 'very', 'quite', 'bit', 'sort', 'kind', 'thing',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'time', 'times',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'location', 'wrong', 'already', 'applied', 'elsewhere', 'type',
  'span', 'div', 'nbsp', 'href', 'strong', 'em', 'ul', 'ol', 'li', 'br', 'img',
  'style', 'class', 'rsquo', 'lsquo', 'ldquo', 'rdquo', 'amp', 'quot', 'apos',
  'font', 'color', 'align', 'width', 'height', 'padding', 'margin', 'border',
  'props', 'data', 'html', 'body', 'src', 'alt', 'utm', 'gh', 'jid',
  'across', 'other', 'others', 'high', 'highly', 'through', 'within', 'including', 'include',
  'ensure', 'also', 'well', 'based', 'related', 'using', 'use', 'used', 'make', 'able',
  'ability', 'may', 'must', 'will', 'can', 'our', 'your', 'their', 'etc', 'via', 'per',
  'more', 'most', 'best', 'great', 'good', 'key', 'level', 'low', 'every', 'each', 'into',
  'application', 'applications', 'architecture', 'api', 'apis', 'service', 'services',
  'technology', 'technologies', 'technical', 'management', 'manage', 'business', 'solution',
  'solutions', 'customer', 'customers', 'teams', 'skills', 'skill', 'operations', 'while',
  'environment', 'requirements', 'responsibilities', 'knowledge', 'understanding', 'support',
  'development', 'develop', 'process', 'processes', 'product', 'products', 'quality', 'tools',
  'project', 'projects', 'global', 'world', 'people', 'opportunity', 'position', 'candidate',
  'qualifications', 'preferred', 'plus', 'excellent', 'communication', 'collaborate',
  'collaboration', 'stakeholders', 'deliver', 'delivery', 'drive', 'impact', 'problems',
  'solve', 'systems', 'system', 'design', 'implementation', 'implement', 'features', 'feature',
  'disability', 'disabilities', 'disabled', 'veteran', 'veterans', 'gender', 'race', 'ethnicity',
  'ethnic', 'religion', 'religious', 'orientation', 'sexual', 'sex', 'national', 'origin',
  'equal', 'employer', 'accommodation', 'accommodations', 'protected', 'status', 'marital',
  'pregnancy', 'age', 'identity', 'expression', 'live', 'lives', 'living',
  'dedicated', 'passionate', 'growth', 'grow', 'exciting', 'fast', 'paced', 'innovative',
  'driven', 'committed', 'mission', 'culture', 'opportunities', 'growing', 'dynamic',
]);

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Load learned preference signals for a profile.
 */
export async function loadSignals(profileId: string): Promise<Map<string, number>> {
  const rows = await prisma.preferenceSignal.findMany({ where: { profileId } });
  // Filter on the way out as well as on the way in. Terms banned after they
  // were already learned would otherwise keep scoring for ever, and a stored
  // weight on "span" is not something anyone can see to delete.
  return new Map(rows.filter((r) => countable(r.term)).map((r) => [r.term, r.weight]));
}

/**
 * Fold one decision into the lexical model.
 *
 * Weights move by a decaying step, so the fortieth rejection nudges rather than
 * lurches, and a single mis-click cannot poison a term. Terms are clamped so
 * nothing becomes an absolute veto - that is the model pass's job, not a bag of
 * words'.
 */
export async function learnFromDecision(args: {
  profileId: string;
  job: ScorableJob;
  accepted: boolean;
  /** The candidate's own words, when they gave a reason. */
  reason?: string;
}): Promise<{ moved: string[] }> {
  const terms = jobTerms(args.job).slice(0, 30);

  // A stated reason is far better evidence than the whole posting, because it
  // isolates *what* was wrong. Terms named in the reason move twice as far.
  const reasonTerms = new Set(
    args.reason ? tokenize(normalizeLabel(args.reason)).filter((t) => !STOP_TERMS.has(t)) : [],
  );

  const direction = args.accepted ? 1 : -1;
  const moved: string[] = [];

  for (const term of terms) {
    const emphasised = reasonTerms.has(term);
    const existing = await prisma.preferenceSignal.findUnique({
      where: { profileId_term: { profileId: args.profileId, term } },
    });
    const evidence = (existing?.evidence ?? 0) + 1;
    // Step decays with evidence: early decisions teach fast, later ones refine.
    const step = (emphasised ? 1.0 : 0.35) / Math.sqrt(evidence);
    const next = clamp((existing?.weight ?? 0) + direction * step, -4, 4);

    await prisma.preferenceSignal.upsert({
      where: { profileId_term: { profileId: args.profileId, term } },
      create: { profileId: args.profileId, term, weight: next, evidence: 1, origin: 'LEXICAL' },
      update: { weight: next, evidence },
    });
    if (emphasised) moved.push(term);
  }

  // Terms that appear only in the reason ("commute", "salary", "on-site") never
  // appear in jobTerms but are the most informative thing the candidate said.
  for (const term of reasonTerms) {
    if (terms.includes(term)) continue;
    const existing = await prisma.preferenceSignal.findUnique({
      where: { profileId_term: { profileId: args.profileId, term } },
    });
    const evidence = (existing?.evidence ?? 0) + 1;
    const next = clamp((existing?.weight ?? 0) + direction * (1.2 / Math.sqrt(evidence)), -4, 4);
    await prisma.preferenceSignal.upsert({
      where: { profileId_term: { profileId: args.profileId, term } },
      create: { profileId: args.profileId, term, weight: next, evidence: 1, origin: 'LEXICAL' },
      update: { weight: next, evidence },
    });
    moved.push(term);
  }

  return { moved };
}
