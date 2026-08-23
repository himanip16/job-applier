import { z } from 'zod';
import { normalizeLabel, tokenize } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { generate, describeLlmError } from '../llm/client.js';
import type { DiscoveredJob } from './sources.js';

/**
 * Ranking leads, and learning to rank them better.
 *
 * Two layers, on purpose:
 *
 *  - A **lexical prior** built from your own decisions. Every time you reject a
 *    job with a reason, the terms distinctive to that job get pushed down;
 *    every time you shortlist one, its terms get pushed up. It is a naive
 *    weighted-term model, which is exactly right here: the training set is
 *    fifty decisions, not fifty thousand, and the weights stay legible enough
 *    that you can open the table and delete one that has gone stale.
 *
 *  - A **model pass** over the top candidates only. It sees your profile, your
 *    stated preferences, and a summary of what you have been rejecting, and it
 *    reads the actual description. This is where "senior enough?", "is this
 *    really backend or is it devops?" and "does the stack match?" get decided.
 *
 * Running the cheap layer over everything and the expensive layer over the
 * shortlist keeps a 400-job crawl affordable while still giving the jobs you
 * are likely to care about a real read.
 */

const STOP_TERMS = new Set([
  // Role filler: on every posting, so it distinguishes nothing.
  'engineer', 'engineering', 'senior', 'staff', 'lead', 'principal', 'developer',
  'software', 'team', 'work', 'working', 'role', 'job', 'company', 'experience',
  'years', 'strong', 'looking', 'join', 'help', 'build', 'building', 'new',
  // Sentence scaffolding. These arrive via free-text rejection reasons, where
  // the candidate is writing prose rather than tagging. Learning "five" from
  // "five day commute" would quietly penalise every posting that mentions a
  // number of anything.
  'not', 'no', 'nope', 'thanks', 'really', 'just', 'want', 'wanted', 'like',
  'need', 'much', 'too', 'very', 'quite', 'bit', 'sort', 'kind', 'thing',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'time', 'times',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  // Category chips are prefixed with these; the discriminating word is the
  // rest of the phrase.
  'location', 'wrong', 'already', 'applied', 'elsewhere', 'type',
  // Markup that leaked into descriptions before stripHtml learned to handle
  // Greenhouse's double-escaped content. The parser is fixed, but weights
  // learned from the old text are still in the database and postings already
  // stored still contain it, so these stay permanently unlearnable rather than
  // relying on a re-crawl.
  'span', 'div', 'nbsp', 'href', 'strong', 'em', 'ul', 'ol', 'li', 'br', 'img',
  'style', 'class', 'rsquo', 'lsquo', 'ldquo', 'rdquo', 'amp', 'quot', 'apos',
  'font', 'color', 'align', 'width', 'height', 'padding', 'margin', 'border',
  'props', 'data', 'html', 'body', 'src', 'alt', 'utm', 'gh', 'jid',
]);

/** Terms that characterise a posting, for the lexical model. */
export function jobTerms(job: Pick<DiscoveredJob, 'title' | 'descriptionText' | 'location'>): string[] {
  const title = tokenize(normalizeLabel(job.title));
  // The first chunk of a description is where the role is actually defined;
  // the tail is benefits boilerplate and EEO statements.
  const body = tokenize(normalizeLabel((job.descriptionText ?? '').slice(0, 3000)));
  const loc = tokenize(normalizeLabel(job.location ?? ''));

  const counts = new Map<string, number>();
  // Title terms count for far more than body terms.
  for (const t of title) if (!STOP_TERMS.has(t)) counts.set(t, (counts.get(t) ?? 0) + 4);
  for (const t of loc) if (!STOP_TERMS.has(t)) counts.set(t, (counts.get(t) ?? 0) + 2);
  for (const t of body) if (!STOP_TERMS.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);

  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([t]) => t);
}

export interface LexicalScore {
  score: number;
  positives: string[];
  negatives: string[];
}

/** Score a job against the learned preference signals. Cheap, no network. */
export function scoreLexically(
  job: Pick<DiscoveredJob, 'title' | 'descriptionText' | 'location'>,
  signals: Map<string, number>,
): LexicalScore {
  const terms = jobTerms(job);
  let total = 0;
  const positives: string[] = [];
  const negatives: string[] = [];

  for (const term of terms) {
    const w = signals.get(term);
    if (w === undefined || Math.abs(w) < 0.15) continue;
    total += w;
    if (w > 0) positives.push(term);
    else negatives.push(term);
  }

  // Squash to 0-100 around a neutral 50, so an unseen job with no matching
  // signals lands mid-pack rather than at either extreme.
  const score = 100 / (1 + Math.exp(-total / 3));
  return {
    score,
    positives: positives.slice(0, 6),
    negatives: negatives.slice(0, 6),
  };
}

export async function loadSignals(profileId: string): Promise<Map<string, number>> {
  const rows = await prisma.preferenceSignal.findMany({ where: { profileId } });
  // Filter on the way out as well as on the way in. Terms banned after they
  // were already learned would otherwise keep scoring for ever, and a stored
  // weight on "span" is not something anyone can see to delete.
  return new Map(rows.filter((r) => !STOP_TERMS.has(r.term)).map((r) => [r.term, r.weight]));
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
  job: Pick<DiscoveredJob, 'title' | 'descriptionText' | 'location'>;
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

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ------------------------------------------------------------- model pass ---

const FitSchema = z.object({
  score: z.number().describe('0-100. How well this job fits this candidate, all things considered.'),
  verdict: z.enum(['STRONG', 'WORTH_A_LOOK', 'STRETCH', 'MISMATCH']),
  forIt: z.array(z.string()).describe('Concrete reasons this is a good fit. Cite the posting.'),
  againstIt: z.array(z.string()).describe('Concrete reasons it is not. Include anything that contradicts their stated preferences.'),
  seniorityFit: z.enum(['BELOW', 'MATCH', 'ABOVE', 'UNCLEAR']),
  dealbreaker: z.string().describe('A single hard blocker if one exists (visa, location, clearance), otherwise empty.'),
});

export type FitAssessment = z.infer<typeof FitSchema>;

const FIT_SYSTEM = `You triage job postings for one specific candidate. You are the filter that decides whether a real person spends twenty minutes applying.

Judge fit, not quality. A prestigious job that does not match this candidate is a MISMATCH.

Weigh, in this order:
1. Hard blockers. Location they cannot work in, visa sponsorship the posting rules out, clearance they do not hold, a seniority band far off theirs. Any of these makes it a MISMATCH regardless of how well the rest reads.
2. What they have explicitly rejected before. The rejection history is the strongest available signal about what they actually want, and it usually contradicts what a resume implies. Respect it.
3. Skill and domain overlap with their actual experience, not with adjacent things they could plausibly learn.
4. Seniority. Being two levels under the bar wastes their time; being three levels over it wastes it differently.

Be decisive and be specific. "Good technical match" is useless; "their four years on payment ledgers maps directly onto the settlement work in the third bullet" is what the candidate needs to see. Cite the posting in your reasons.

Do not inflate. Most postings a crawler finds are a poor fit, and a triage tool that calls everything a 75 is worthless.`;

export async function assessFit(args: {
  candidateContext: string;
  preferences: string;
  rejectionHistory: string;
  job: Pick<DiscoveredJob, 'title' | 'companyName' | 'location' | 'descriptionText' | 'remote'>;
}): Promise<FitAssessment | null> {
  try {
    return await generate({
      task: 'fitScoring',
      system: FIT_SYSTEM,
      prompt: `${args.candidateContext}

<stated_preferences>
${args.preferences || 'None recorded.'}
</stated_preferences>

<what_they_have_rejected_before>
${args.rejectionHistory || 'No rejection history yet.'}
</what_they_have_rejected_before>

<posting>
title: ${args.job.title}
company: ${args.job.companyName}
location: ${args.job.location ?? 'not stated'}${args.job.remote ? ' (remote)' : ''}

${args.job.descriptionText.slice(0, 12000)}
</posting>

Assess the fit.`,
      schema: FitSchema,
      maxTokens: 3000,
    });
  } catch (err) {
    throw new Error(describeLlmError(err));
  }
}

/**
 * A compact, human-readable summary of what this candidate turns down and why,
 * regenerated from the reasons they actually typed. Injected into the fit
 * prompt so the model's judgement moves with the candidate's, not just the
 * bag-of-words.
 */
export async function buildRejectionHistory(profileId: string, limit = 25): Promise<string> {
  const rejected = await prisma.jobLead.findMany({
    where: { profileId, status: 'REJECTED' },
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

/** The candidate's own words about what they want, from their profile facts. */
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

export function serialiseReasons(
  lexical: LexicalScore,
  fit: FitAssessment | null,
): Prisma.InputJsonValue {
  return {
    lexicalScore: Math.round(lexical.score),
    likedTerms: lexical.positives,
    dislikedTerms: lexical.negatives,
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
