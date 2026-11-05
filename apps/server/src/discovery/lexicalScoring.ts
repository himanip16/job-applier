import { levelMismatch, wrongDomain } from './leadCleanup.js';
import { entryLevelVerdict, isEntryLevelTitle } from './hardRules.js';
import { jobTermWeights, countable, type ScorableJob } from './featureExtraction.js';

/**
 * A title that names a technical role. An engineer's resume shares plenty of
 * ordinary business words with a consulting or HR posting, so without this a
 * "Management Consultant - Financial Risk" scored 83%.
 */
const TECH_TITLE =
  /engineer|developer|software|\bsde\b|back[- ]?end|front[- ]?end|full[- ]?stack|platform|devops|\bsre\b|reliability|infrastructure|\bdata\b|machine learning|\bml\b|\bai\b|architect|programmer|technical|technology|security|cloud|mobile|\bios\b|android|\bqa\b|\btest|automation|systems|kubernetes|golang|java|python|scientist/i;

/**
 * A title that is only frontend. Full-stack and backend titles are left alone:
 * those are the candidate's job with some UI in it, not a different one.
 */
const FRONTEND_TITLE = /\b(front[- ]?end|ui engineer|ui developer|web ui)\b/i;
const SPANS_BACKEND = /\b(full[- ]?stack|back[- ]?end)\b/i;

/**
 * The most a frontend role scores for a backend candidate. Engineering, and
 * a job they could do, but a step sideways: worth a look, never a top match.
 */
const FRONTEND_CAP = 60;

/** The most a non-technical title can score for a technical candidate. */
const OFF_ROLE_CAP = 20;

/**
 * How much of its distance from 50 a keyword score keeps when it stands alone
 * in the list.
 *
 * Model reads and keyword guesses sort on one column. The model is told not to
 * inflate, so a real fit it read in full lands around 70-80, while word overlap
 * alone reached 92 - and an unread posting outranked the read one above it.
 * At 0.45 an unread lead tops out near 69: under the 70 that marks a strong
 * match, which only a read can award, and still above a model's mismatch.
 * Order among unread leads is unchanged. `score` keeps its full range, because
 * the model blend and the pick of which leads to read both want it.
 */
const UNREAD_SHRINK = 0.45;

/**
 * Where an average posting lands, and how hard affinity pushes away from it.
 *
 * A description is mostly words no resume contains - benefits, values, the
 * legal footer - so coverage of even a perfect match tops out well under half.
 * These two put the realistic 0.15-0.6 band across most of the 0-100 range
 * instead of bunching it around the middle. The ranking test over real board
 * titles is what keeps them honest.
 */
const AFFINITY_NEUTRAL = 0.35;

/**
 * How far learned weights can move a quick score, and how many matching terms
 * it takes to earn all of it.
 *
 * Learned weights used to be summed, over as many as sixty terms. Every job
 * you applied to raised "cloud", "google" and "dedicated" a little, a posting
 * that said all three summed past anything the resume could say, and an Azure
 * Cloud Architect scored 100% for a backend engineer on words alone. The mean
 * says what the matching terms are worth; the count only decides how much of
 * it to believe.
 */
const LEARNED_MAX_DRIVE = 2.5;
const LEARNED_FULL_HITS = 3;

/**
 * The furthest a keyword score sits from the middle. It is a guess from word
 * overlap, and "100%" on a guess reads as certainty it does not have.
 */
const QUICK_SCORE_SPAN = 42;
const AFFINITY_GAIN = 7;

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
  /** Why the score was held down regardless of the words, when it was. */
  capped?: { tag: string; reason: string };
  /**
   * The score a lead carries while no model has read it: `score` pulled toward
   * the middle, then capped. See UNREAD_SHRINK.
   */
  unreadScore: number;
}

export interface ScoringContext {
  /** Learned term weights, from decisions the candidate has made. */
  signals: Map<string, number>;
  /** Every word that appears in the candidate's resume, summary or facts. */
  vocabulary: Set<string>;
  /** The resume is an engineer's: non-technical titles are capped, not ranked on shared words. */
  technical?: boolean;
  /**
   * The resume is a backend engineer's: frontend-only titles are capped. A
   * backend resume mentions TypeScript and "frontend" in passing, so word
   * overlap ranked a Frontend Engineer role at 100%.
   */
  backend?: boolean;
  /** Years of experience, so new-grad and intern titles are capped for someone who works. */
  candidateYears?: number | null;
}

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

  const learnedWeights: number[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const term of new Set(byWeight.map(([t]) => t))) {
    const w = ctx.signals.get(term);
    if (w === undefined || Math.abs(w) < 0.15) continue;
    learnedWeights.push(w);
    if (w > 0) positives.push(term);
    else negatives.push(term);
  }

  // Squash to 0-100. With neither a resume nor a matching signal the drive is
  // zero and the job lands mid-pack, which is the honest answer when nothing
  // is known - but now it is the rare case rather than every row.
  const learnedMean = learnedWeights.length
    ? learnedWeights.reduce((a, b) => a + b, 0) / learnedWeights.length
    : 0;
  const learned =
    LEARNED_MAX_DRIVE *
    Math.tanh(learnedMean / 2) *
    Math.min(1, learnedWeights.length / LEARNED_FULL_HITS);
  const drive = (known ? AFFINITY_GAIN * (affinity - AFFINITY_NEUTRAL) : 0) + learned;
  const raw = 50 + QUICK_SCORE_SPAN * Math.tanh(drive / 2);
  // A sales engineer or a Workday configurator is off-role however many
  // words the description shares with the resume.
  // The title decides what the job is, and no amount of shared vocabulary
  // changes it. A new-grad role or an architect role shares a backend
  // engineer's whole vocabulary and is still the wrong job.
  const years: number | null = ctx.candidateYears ?? null;
  const domain = wrongDomain(job.title);
  // With no years on file, an engineer's resume is still evidence enough that
  // an internship is not the next job.
  const entryLevel =
    years === null && ctx.technical && isEntryLevelTitle(job.title)
      ? { against: 'Written for graduates or interns, and your resume is a working engineer\'s.' }
      : entryLevelVerdict(years, job.title);
  const capped =
    domain !== null
      ? { tag: domain, reason: `Not a software engineering role: this is ${domain}.` }
      : ctx.technical && !TECH_TITLE.test(job.title)
        ? { tag: 'not engineering', reason: 'The title does not name an engineering role.' }
        : ctx.backend && FRONTEND_TITLE.test(job.title) && !SPANS_BACKEND.test(job.title)
          ? { tag: 'frontend', reason: 'A frontend role; your resume is backend.', cap: FRONTEND_CAP }
        : entryLevel
          ? { tag: 'entry level', reason: entryLevel.against! }
          : levelMismatch(job.title, years);
  const cap = capped ? ('cap' in capped ? (capped.cap ?? OFF_ROLE_CAP) : OFF_ROLE_CAP) : 100;
  const score = Math.min(raw, cap);
  const unreadScore = Math.min(50 + (raw - 50) * UNREAD_SHRINK, cap);

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
    ...(capped ? { capped: { tag: capped.tag, reason: capped.reason } } : {}),
    unreadScore,
  };
}
