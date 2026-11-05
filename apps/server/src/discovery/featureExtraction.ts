import { normalizeLabel, tokenize } from '@ja/shared';
import { getTopSkills, type ResumeKeyword } from './keywordExtraction.js';

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

/**
 * Stop terms that should not be learned or counted.
 *
 * These include role filler words, sentence scaffolding, markup, connective
 * filler, words every tech posting shares, EEO boilerplate, and recruiting
 * adjectives.
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
  // Connective filler every posting and every resume share. They matched
  // anything to anything - "across", "other" and "high" were among the terms
  // that put a management-consulting role at 83% for a backend engineer.
  'across', 'other', 'others', 'high', 'highly', 'through', 'within', 'including', 'include',
  'ensure', 'also', 'well', 'based', 'related', 'using', 'use', 'used', 'make', 'able',
  'ability', 'may', 'must', 'will', 'can', 'our', 'your', 'their', 'etc', 'via', 'per',
  'more', 'most', 'best', 'great', 'good', 'key', 'level', 'low', 'every', 'each', 'into',
  // Words every tech posting and every tech resume share. They put "Workday
  // Extend Developer" at 99% and "People Technology Delivery Lead" at 98% for
  // a backend engineer, on "application, architecture, apis, services,
  // technology, management" - agreement about nothing.
  'application', 'applications', 'architecture', 'api', 'apis', 'service', 'services',
  'technology', 'technologies', 'technical', 'management', 'manage', 'business', 'solution',
  'solutions', 'customer', 'customers', 'teams', 'skills', 'skill', 'operations', 'while',
  'environment', 'requirements', 'responsibilities', 'knowledge', 'understanding', 'support',
  'development', 'develop', 'process', 'processes', 'product', 'products', 'quality', 'tools',
  'project', 'projects', 'global', 'world', 'people', 'opportunity', 'position', 'candidate',
  'qualifications', 'preferred', 'plus', 'excellent', 'communication', 'collaborate',
  'collaboration', 'stakeholders', 'deliver', 'delivery', 'drive', 'impact', 'problems',
  'solve', 'systems', 'system', 'design', 'implementation', 'implement', 'features', 'feature',
  // The equal-opportunity footer, and the EEO answers saved as profile facts.
  // "disability" and "live" put a 2026 new-grad role at 100% for a working
  // engineer: the posting and the profile agreed about the legal boilerplate.
  'disability', 'disabilities', 'disabled', 'veteran', 'veterans', 'gender', 'race', 'ethnicity',
  'ethnic', 'religion', 'religious', 'orientation', 'sexual', 'sex', 'national', 'origin',
  'equal', 'employer', 'accommodation', 'accommodations', 'protected', 'status', 'marital',
  'pregnancy', 'age', 'identity', 'expression', 'live', 'lives', 'living',
  // Recruiting adjectives. Every posting is dedicated, passionate and
  // fast-paced, so they gather learned weight from whatever you apply to and
  // then lift everything else that says them.
  'dedicated', 'passionate', 'growth', 'grow', 'exciting', 'fast', 'paced', 'innovative',
  'driven', 'committed', 'mission', 'culture', 'opportunities', 'growing', 'dynamic',
]);

/**
 * A word that can say what a job is. Bare numbers cannot: "2026" is on every
 * resume as a date and in every new-grad title as a class year, and matching
 * one to the other is what made a graduate role look like a perfect fit.
 */
export const countable = (term: string) => !STOP_TERMS.has(term) && !/^\d+$/.test(term);

/**
 * Terms that characterise a posting, split by where they came from.
 */
export function jobTermWeights(
  job: ScorableJob,
): { title: Map<string, number>; body: Map<string, number> } {
  const title = new Map<string, number>();
  const body = new Map<string, number>();
  const add = (into: Map<string, number>, term: string, n: number) => {
    if (!countable(term)) return;
    into.set(term, (into.get(term) ?? 0) + n);
  };

  // Title terms count for far more than body terms.
  for (const t of tokenize(normalizeLabel(job.title))) add(title, t, 4);
  // The location is not counted: "India" on a posting matching "India" on a
  // resume says where, not what, and the country filter already handles where.
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
  return new Set(tokenize(normalizeLabel(text)).filter(countable));
}

/**
 * Build the candidate's vocabulary including extracted skills from resume.
 */
export function buildVocabulary(profile: {
  resumeText?: string | null;
  summary?: string | null;
  facts?: { value: string }[];
  resumeKeywords?: ResumeKeyword[] | null;
}): Set<string> {
  const vocabulary = profileVocabulary(profile);
  // The resume's strongest skills, extracted once at upload, widen what counts as a match.
  const resumeKeywords = (profile.resumeKeywords as ResumeKeyword[] | null) ?? [];
  for (const skill of getTopSkills(resumeKeywords, 20)) {
    const normalized = normalizeLabel(skill);
    if (normalized) vocabulary.add(normalized);
  }
  return vocabulary;
}
