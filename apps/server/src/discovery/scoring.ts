import { z } from 'zod';
import { normalizeLabel, tokenize } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { generate, describeLlmError } from '../llm/client.js';
import type { DiscoveredJob } from './sources.js';
import { getTopSkills, type ResumeKeyword } from './keywordExtraction.js';

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

/**
 * The least a posting can be and still be scorable.
 *
 * A search hit is often a title and nothing else - no description was ever
 * fetched - and that has to score rather than fail to typecheck.
 */
export interface ScorableJob {
  title: string;
  descriptionText?: string | null;
  location?: string | null;
}

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

/** Terms that characterise a posting, split by where they came from. */
function jobTermWeights(
  job: ScorableJob,
): { title: Map<string, number>; body: Map<string, number> } {
  const title = new Map<string, number>();
  const body = new Map<string, number>();
  const add = (into: Map<string, number>, term: string, n: number) => {
    if (STOP_TERMS.has(term)) return;
    into.set(term, (into.get(term) ?? 0) + n);
  };

  // Title terms count for far more than body terms.
  for (const t of tokenize(normalizeLabel(job.title))) add(title, t, 4);
  for (const t of tokenize(normalizeLabel(job.location ?? ''))) add(body, t, 2);
  // The first chunk of a description is where the role is actually defined;
  // the tail is benefits boilerplate and EEO statements.
  for (const t of tokenize(normalizeLabel((job.descriptionText ?? '').slice(0, 3000)))) {
    add(body, t, 1);
  }

  // A body term said once is noise; a title term said once is the job.
  for (const [t, n] of body) if (n < 2) body.delete(t);
  const trimmed = new Map(
    [...body.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60),
  );
  return { title, body: trimmed };
}

/** Terms that characterise a posting, for the lexical model. */
export function jobTerms(job: ScorableJob): string[] {
  const { title, body } = jobTermWeights(job);
  const merged = new Map(body);
  for (const [t, n] of title) merged.set(t, (merged.get(t) ?? 0) + n);
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([t]) => t);
}

/**
 * The candidate's own vocabulary, from their resume and everything else they
 * have told us.
 *
 * This is the half of the ranking that was missing, and its absence is what
 * made a fresh crawl useless: the lexical score used to be built only from
 * learned preference weights, so a profile that had not rejected anything yet
 * scored *every* posting at exactly 50 - a backend role and a sales role tied,
 * and the "top 15 to read in full" was really "the first 15 stored".
 */
export function profileVocabulary(profile: {
  resumeText?: string | null;
  summary?: string | null;
  facts?: { value: string }[];
}): Set<string> {
  const text = [
    profile.resumeText ?? '',
    profile.summary ?? '',
    ...(profile.facts ?? []).map((f) => f.value),
  ].join('\n');
  return new Set(tokenize(normalizeLabel(text)).filter((t) => !STOP_TERMS.has(t)));
}

/** Everything the cheap pass needs, loaded once per crawl rather than per job. */
export interface ScoringContext {
  /** Learned term weights, from decisions the candidate has made. */
  signals: Map<string, number>;
  /** Every word that appears in the candidate's resume, summary or facts. */
  vocabulary: Set<string>;
}

export async function loadScoringContext(profileId: string): Promise<ScoringContext> {
  const [signals, profile] = await Promise.all([
    loadSignals(profileId),
    prisma.profile.findUnique({ where: { id: profileId }, include: { facts: true } }),
  ]);
  
  const baseVocabulary: Set<string> = profile ? profileVocabulary(profile) : new Set();
  
  // Boost vocabulary with extracted resume keywords for better matching
  const resumeKeywords = (profile?.resumeKeywords as ResumeKeyword[] | null) ?? [];
  const topSkills = getTopSkills(resumeKeywords, 20);
  
  // Add top skills to vocabulary with higher weight consideration
  const enhancedVocabulary = new Set<string>(baseVocabulary);
  for (const skill of topSkills) {
    const normalized = normalizeLabel(skill);
    if (normalized) {
      enhancedVocabulary.add(normalized);
    }
  }
  
  return { signals, vocabulary: enhancedVocabulary };
}

export interface LexicalScore {
  score: number;
  positives: string[];
  negatives: string[];
  /**
   * How much of the posting's own vocabulary the candidate has, 0-1. Half of
   * it is the title, whatever the length of the description, because the title
   * is half of what you know about a job at a glance.
   */
  affinity: number;
  /** Words the posting leans on that the candidate's resume also uses. */
  shared: string[];
  /** Words the posting leans on that appear nowhere in the resume. */
  missing: string[];
  /**
   * How far this score should be trusted against a model's read, 0-1. A
   * profile with no resume and no decision history has no opinion, and saying
   * so is better than voting 50 on everything.
   */
  confidence: number;
}

/**
 * Where an average posting lands, and how hard affinity pushes away from it.
 *
 * A description is mostly words no resume contains - benefits, values, the
 * legal footer - so coverage of even a perfect match tops out well under half.
 * These two put the realistic 0.15-0.6 band across most of the 0-100 range
 * instead of bunching it around the middle. The ranking test over real board
 * titles is what keeps them honest.
 */
const AFFINITY_NEUTRAL = 0.30;
const AFFINITY_GAIN = 9;

/**
 * How much neutral evidence every coverage figure starts with.
 *
 * "Software Engineer - Infrastructure" carries exactly one term the stoplist
 * does not eat, so unsmoothed coverage of it is 0 or 1 and the posting scores
 * either 8 or 99 on the strength of a single word. Twelve is three title
 * terms' worth of "no opinion", which pulls a one-word title back toward the
 * middle while leaving a full description - forty-odd terms - almost
 * untouched. Short evidence should produce a soft answer.
 */
const AFFINITY_PRIOR = 12;

/** Below this, there is not enough resume to judge overlap against. */
const MIN_VOCABULARY = 15;

/** Score a job against the resume and the learned preference signals. Cheap, no network. */
export function scoreLexically(job: ScorableJob, ctx: ScoringContext): LexicalScore {
  const { title, body } = jobTermWeights(job);
  const known = ctx.vocabulary.size >= MIN_VOCABULARY;

  const coverage = (terms: Map<string, number>) => {
    let total = 0;
    let covered = 0;
    for (const [term, w] of terms) {
      total += w;
      if (ctx.vocabulary.has(term)) covered += w;
    }
    // Smoothed toward neutral, so a short title cannot swing the whole score
    // on one word.
    return total ? (covered + AFFINITY_PRIOR * AFFINITY_NEUTRAL) / (total + AFFINITY_PRIOR) : null;
  };

  const titleCoverage = coverage(title);
  const bodyCoverage = coverage(body);
  // The title gets half the vote when there is a description to weigh it
  // against, and all of it when there is not - a search hit is often a title
  // and nothing else.
  const affinity =
    titleCoverage === null
      ? (bodyCoverage ?? 0)
      : bodyCoverage === null
        ? titleCoverage
        : 0.5 * titleCoverage + 0.5 * bodyCoverage;

  const shared: string[] = [];
  const missing: string[] = [];
  const byWeight = [...title.entries(), ...body.entries()].sort((a, b) => b[1] - a[1]);
  for (const [term] of byWeight) {
    (ctx.vocabulary.has(term) ? shared : missing).push(term);
  }

  let learned = 0;
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const term of new Set(byWeight.map(([t]) => t))) {
    const w = ctx.signals.get(term);
    if (w === undefined || Math.abs(w) < 0.15) continue;
    learned += w;
    if (w > 0) positives.push(term);
    else negatives.push(term);
  }

  // Squash to 0-100. With neither a resume nor a matching signal the drive is
  // zero and the job lands mid-pack, which is the honest answer when nothing
  // is known - but now it is the rare case rather than every row.
  const drive = (known ? AFFINITY_GAIN * (affinity - AFFINITY_NEUTRAL) : 0) + learned / 3;
  const score = 100 / (1 + Math.exp(-drive));

  const hits = positives.length + negatives.length;
  const confidence = Math.min(1, (known ? 0.7 : 0) + Math.min(0.3, hits * 0.075));

  return {
    score,
    positives: positives.slice(0, 6),
    negatives: negatives.slice(0, 6),
    affinity,
    shared: shared.slice(0, 8),
    missing: missing.slice(0, 8),
    confidence,
  };
}

/**
 * Put a model's read and the cheap pass on one number.
 *
 * The cheap pass only gets a vote in proportion to what it actually knows.
 * When it was scoring everything at 50 it still took a flat 30% of every
 * blend, which dragged a model's 90 down to 78 and its 20 up to 29 - the whole
 * range squeezed toward the middle by a number carrying no information.
 */
export function blendScores(fit: FitAssessment, lexical: LexicalScore): number {
  if (fit.dealbreaker) return Math.min(fit.score, 15);
  const weight = 0.3 * lexical.confidence;
  return (1 - weight) * fit.score + weight * lexical.score;
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
2. Experience match. If the posting gives a minimum years of experience and the candidate is materially under it, that is a major negative. A 4-year candidate is not a strong match for an 8+ year requirement, even if the domain overlap is good. Do not hand-wave this away as "similar role" or "senior enough"; a real mismatch should drag the score down sharply and usually be called out in the reasons.
3. What they have explicitly rejected before. The rejection history is the strongest available signal about what they actually want, and it usually contradicts what a resume implies. Respect it.
4. Skill and domain overlap with their actual experience, not with adjacent things they could plausibly learn.
5. Seniority. Being two levels under the bar wastes their time; being three levels over it wastes it differently.

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
 * Batch version of assessFit that scores multiple jobs in a single LLM call.
 * This is more efficient than calling assessFit for each job individually.
 */
const BatchFitSchema = z.object({
  assessments: z.array(
    z.object({
      index: z.number().describe('Index of the job in the input array (0-based).'),
      score: z.number().describe('0-100. How well this job fits this candidate, all things considered.'),
      verdict: z.enum(['STRONG', 'WORTH_A_LOOK', 'STRETCH', 'MISMATCH']),
      forIt: z.array(z.string()).describe('Concrete reasons this is a good fit. Cite the posting.'),
      againstIt: z.array(z.string()).describe('Concrete reasons it is not. Include anything that contradicts their stated preferences.'),
      seniorityFit: z.enum(['BELOW', 'MATCH', 'ABOVE', 'UNCLEAR']),
      dealbreaker: z.string().describe('A single hard blocker if one exists (visa, location, clearance), otherwise empty.'),
    })
  )
});

export async function assessFitBatch(args: {
  candidateContext: string;
  preferences: string;
  rejectionHistory: string;
  jobs: Array<Pick<DiscoveredJob, 'title' | 'companyName' | 'location' | 'descriptionText' | 'remote'>>;
}): Promise<(FitAssessment | null)[]> {
  if (args.jobs.length === 0) return [];
  
  // For very small batches, use individual calls to avoid complexity
  if (args.jobs.length <= 3) {
    const results = await Promise.all(
      args.jobs.map(job => 
        assessFit({ ...args, job }).catch(() => null)
      )
    );
    return results;
  }

  try {
    const jobsText = args.jobs.map((job, idx) => 
      `<job_${idx}>
title: ${job.title}
company: ${job.companyName}
location: ${job.location ?? 'not stated'}${job.remote ? ' (remote)' : ''}

${job.descriptionText.slice(0, 8000)}
</job_${idx}>`
    ).join('\n\n');

    const result = await generate({
      task: 'fitScoring',
      system: FIT_SYSTEM + '\n\nYou are scoring multiple jobs at once. Return an assessment for each job with its index.',
      prompt: `${args.candidateContext}

<stated_preferences>
${args.preferences || 'None recorded.'}
</stated_preferences>

<what_they_have_rejected_before>
${args.rejectionHistory || 'No rejection history yet.'}
</what_they_have_rejected_before>

<postings>
${jobsText}
</postings>

Assess the fit for each job. Return an array of assessments, one for each job, with the index matching the job number.`,
      schema: BatchFitSchema,
      maxTokens: 8000,
    });

    if (!result) return args.jobs.map(() => null);

    // Sort assessments by index and return in order
    const sorted = [...result.assessments].sort((a, b) => a.index - b.index);
    const assessments = new Map(sorted.map(a => [a.index, a]));
    
    return args.jobs.map((_, idx) => {
      const assessment = assessments.get(idx);
      if (!assessment) return null;
      const { index, ...fit } = assessment;
      return fit as FitAssessment;
    });
  } catch (err) {
    // Fall back to individual calls if batch fails
    console.error('Batch scoring failed, falling back to individual calls:', err);
    return await Promise.all(
      args.jobs.map(job => 
        assessFit({ ...args, job }).catch(() => null)
      )
    );
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
