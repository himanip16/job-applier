import type { Country } from '@ja/shared';
import { z } from 'zod';
import { normalizeLabel, tokenize } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { generate, isConfigured } from '../llm/client.js';
import { MAX_QUERY_LENGTH } from './firecrawl.js';

/**
 * Turning "who am I" into "what to search for".
 *
 * This is the step that lets the whole feature run without being told which
 * companies to look at. The inputs are all things the app already has: the
 * resume, the stated facts, and - most usefully - the postings this candidate
 * has already shortlisted or rejected. What someone accepts and turns down is
 * a much better description of the job they want than the resume that
 * describes the job they had.
 *
 * A search query is not an answer submitted under anyone's name, so unlike the
 * form-filling path this one is allowed to infer freely: the cost of a bad
 * guess is a few irrelevant rows in a triage queue that you reject in one
 * click, and rejecting them teaches the ranker. That is the opposite of the
 * "never guess" rule elsewhere, and deliberately so.
 */

export interface SearchPlan {
  /** Role titles to match sibling postings against once a board is found. */
  roleTitles: string[];
  /** The actual search strings. */
  queries: string[];
  /** ISO-2 country for geo-targeting, or undefined to leave it to Firecrawl. */
  country?: string;
  /** How the plan was built, so the UI can be honest about it. */
  source: 'model' | 'profile';
  /** Anything the user should know about the plan's quality. */
  notes: string[];
}

const PlanSchema = z.object({
  roleTitles: z
    .array(z.string())
    .describe(
      'Job titles this candidate should be considered for, as they appear on real postings. ' +
        'Two to six of them. Include seniority, e.g. "Staff Backend Engineer", not "Backend".',
    ),
  queries: z
    .array(z.string())
    .describe(
      'Web search queries that would surface those postings. Each should read like a search, ' +
        'not a sentence: role, key technologies, and location where it matters.',
    ),
});

const PLAN_SYSTEM = `You turn one candidate's background into the web searches that would find their next job.

You are writing queries against an index of job postings on applicant tracking systems. A good query is three to eight words: a real job title, the one or two technologies that actually narrow the field, and a location when the candidate is not remote-only.

Rules:
- Use titles companies actually post. "Senior Backend Engineer" and "Staff Software Engineer, Payments" are real; "Backend Ninja" and "Software Engineer III-V" are not.
- Vary the queries. Six near-identical searches return the same ten postings and waste the budget. Cover the distinct directions this person could plausibly go - a different seniority, an adjacent specialisation, a different industry that values the same skill.
- Weight what they have shortlisted or applied to far above what their resume says. The resume describes the job they had.
- Respect stated rejections. If they have turned down on-site roles three times, do not search for a city.
- Never include the candidate's name, email, or employer names from their resume. You are searching for openings, not for them.
- No boolean operators, quotes, or site: filters. The caller adds domain filtering itself.`;

export async function buildSearchPlan(
  profileId: string,
  opts: { maxQueries?: number; country?: Country } = {},
): Promise<SearchPlan> {
  const maxQueries = opts.maxQueries ?? 6;

  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    include: { facts: true },
  });
  if (!profile) throw new Error('No profile yet.');

  const [accepted, rejected] = await Promise.all([
    prisma.jobLead.findMany({
      where: { profileId, status: { in: ['SHORTLISTED', 'APPLIED'] } },
      orderBy: { decidedAt: 'desc' },
      take: 15,
      select: { title: true, companyName: true, location: true },
    }),
    prisma.jobLead.findMany({
      where: { profileId, status: 'REJECTED' },
      orderBy: { decidedAt: 'desc' },
      take: 15,
      select: { title: true, rejectReason: true, rejectCategory: true },
    }),
  ]);

  const notes: string[] = [];
  const resume = (profile.resumeText ?? '').trim();
  const summary = (profile.summary ?? '').trim();

  // With no resume, no summary and no decision history there is genuinely
  // nothing to search for, and inventing something would just burn credits on
  // a stranger's job hunt.
  if (!resume && !summary && !accepted.length) {
    throw new Error(
      'Nothing to search with yet. Add your resume on the Profile page (or shortlist a job you ' +
        'like) so the search knows what to look for.',
    );
  }

  // The country you picked for this search wins over the profile's own.
  const country = opts.country?.code ?? (profile.countryCode || undefined);

  if (isConfigured()) {
    try {
      const plan = await generate({
        task: 'searchPlanning',
        system: PLAN_SYSTEM,
        prompt: renderPlanPrompt({ profile, summary, resume, accepted, rejected, searchCountry: opts.country?.name }),
        schema: PlanSchema,
        maxTokens: 1200,
      });
      const queries = cleanQueries(plan?.queries ?? [], maxQueries);
      const roleTitles = (plan?.roleTitles ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 8);
      if (queries.length) {
        return { roleTitles, queries, country, source: 'model', notes };
      }
      notes.push('The model returned no usable queries, so these were derived from your profile.');
    } catch (err) {
      notes.push(
        `Could not plan searches with the model (${(err as Error).message}); ` +
          'derived them from your profile instead.',
      );
    }
  } else {
    notes.push('No model key configured, so queries were derived from your profile directly.');
  }

  const fallback = profileDerivedPlan({ profile, summary, resume, accepted, maxQueries });
  const place = opts.country?.name;
  const queries = place
    ? fallback.queries.map((q) => (q.toLowerCase().includes(place.toLowerCase()) ? q : `${q} ${place}`))
    : fallback.queries;
  return { ...fallback, queries, country, source: 'profile', notes };
}

function renderPlanPrompt(args: {
  profile: { city: string | null; region: string | null; country: string | null; facts: { label: string; value: string; key: string }[] };
  summary: string;
  resume: string;
  accepted: { title: string; companyName: string; location: string | null }[];
  rejected: { title: string; rejectReason: string | null; rejectCategory: string | null }[];
  searchCountry?: string;
}): string {
  const where = [args.profile.city, args.profile.region, args.profile.country]
    .filter(Boolean)
    .join(', ');

  const relevantFacts = args.profile.facts.filter((f) =>
    /^(preference|logistics|location|compensation|work_auth|experience)\./.test(f.key),
  );

  return [
    `<candidate_location>${where || 'not stated'}</candidate_location>`,
    args.searchCountry
      ? `<search_country>${args.searchCountry}</search_country>\nThe candidate chose to search only in ${args.searchCountry}. Every query must target ${args.searchCountry} (name the country or one of its cities), or be for remote roles open there.`
      : '',
    relevantFacts.length
      ? `<stated_facts>\n${relevantFacts.map((f) => `- ${f.label}: ${f.value}`).join('\n')}\n</stated_facts>`
      : '',
    args.summary ? `<summary>\n${args.summary}\n</summary>` : '',
    args.resume ? `<resume>\n${args.resume.slice(0, 9000)}\n</resume>` : '',
    args.accepted.length
      ? `<they_shortlisted_or_applied_to>\n${args.accepted
          .map((a) => `- ${a.title} at ${a.companyName}${a.location ? ` (${a.location})` : ''}`)
          .join('\n')}\n</they_shortlisted_or_applied_to>`
      : '',
    args.rejected.length
      ? `<they_rejected>\n${args.rejected
          .map(
            (r) =>
              `- ${r.title}${r.rejectReason ? ` - "${r.rejectReason}"` : r.rejectCategory ? ` - ${r.rejectCategory}` : ''}`,
          )
          .join('\n')}\n</they_rejected>`
      : '',
    'Produce the role titles and the search queries.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The no-model path.
 *
 * Form filling works without a model key and so should this. The output is
 * blunter - it cannot invent an adjacent specialisation - but it is built from
 * the same material and is usually enough to find the obvious openings.
 */
function profileDerivedPlan(args: {
  profile: { city: string | null; region: string | null };
  summary: string;
  resume: string;
  accepted: { title: string }[];
  maxQueries: number;
}): { roleTitles: string[]; queries: string[] } {
  const text = `${args.summary}\n${args.resume}`;
  const skills = detectSkills(text);
  const seniority = detectSeniority(text);
  const city = args.profile.city?.trim();

  // Titles the candidate has already chosen to pursue beat anything inferred.
  const chosen = dedupe(args.accepted.map((a) => a.title.trim()).filter(Boolean)).slice(0, 4);

  const roleTitles = dedupe([
    ...chosen,
    ...detectRoleFamilies(text).map((r) => (seniority ? `${seniority} ${r}` : r)),
  ]).slice(0, 6);

  const queries: string[] = [];
  for (const title of roleTitles) {
    for (const skill of skills.length ? skills.slice(0, 2) : ['']) {
      queries.push([title, skill, city].filter(Boolean).join(' '));
    }
  }
  // Something is always better than nothing here: a bare city search still
  // returns openings a person can triage.
  if (!queries.length) queries.push([seniority, 'software engineer', city].filter(Boolean).join(' '));

  return { roleTitles, queries: cleanQueries(queries, args.maxQueries) };
}

/**
 * A deliberately small vocabulary.
 *
 * These are terms that genuinely narrow a job search. A longer list would
 * match more resumes and produce worse queries, because "agile" and "excel"
 * discriminate nothing.
 */
const SKILL_VOCAB = [
  'go', 'golang', 'rust', 'python', 'java', 'kotlin', 'scala', 'ruby', 'elixir', 'c++',
  'typescript', 'javascript', 'react', 'node.js', 'next.js', 'swift', 'android', 'ios',
  'postgres', 'postgresql', 'mysql', 'kafka', 'spark', 'airflow', 'dbt', 'snowflake',
  'kubernetes', 'terraform', 'aws', 'gcp', 'azure', 'graphql', 'grpc',
  'machine learning', 'llm', 'nlp', 'computer vision', 'recommendation',
  'payments', 'fintech', 'ledger', 'billing', 'healthcare', 'security', 'infrastructure',
  'distributed systems', 'observability', 'streaming', 'embedded', 'robotics',
];

const ROLE_FAMILIES: [RegExp, string][] = [
  [/\b(backend|back[- ]end|server[- ]side|api)\b/i, 'Backend Engineer'],
  [/\b(frontend|front[- ]end|react|ui engineer)\b/i, 'Frontend Engineer'],
  [/\bfull[- ]?stack\b/i, 'Full Stack Engineer'],
  [/\b(infrastructure|platform|sre|site reliability|devops)\b/i, 'Platform Engineer'],
  [/\b(data engineer|etl|pipeline|airflow|dbt)\b/i, 'Data Engineer'],
  [/\b(machine learning|ml engineer|deep learning|llm)\b/i, 'Machine Learning Engineer'],
  [/\b(mobile|ios|android|swift|kotlin)\b/i, 'Mobile Engineer'],
  [/\b(security|appsec|infosec)\b/i, 'Security Engineer'],
  [/\b(product manager|program manager)\b/i, 'Product Manager'],
  [/\b(designer|design systems|ux)\b/i, 'Product Designer'],
];

function detectSkills(text: string): string[] {
  const haystack = ` ${normalizeLabel(text)} `;
  return SKILL_VOCAB.filter((s) => haystack.includes(` ${normalizeLabel(s)} `));
}

function detectRoleFamilies(text: string): string[] {
  const found = ROLE_FAMILIES.filter(([re]) => re.test(text)).map(([, name]) => name);
  // No family matched: "Software Engineer" is a poor query but a real one, and
  // an empty plan helps nobody.
  return found.length ? found.slice(0, 3) : ['Software Engineer'];
}

function detectSeniority(text: string): string {
  if (/\b(vp|head of|director)\b/i.test(text)) return 'Director';
  if (/\bprincipal\b/i.test(text)) return 'Principal';
  if (/\bstaff\b/i.test(text)) return 'Staff';
  const years = text.match(/\b(\d{1,2})\+?\s*years?\b/i);
  const n = years ? Number(years[1]) : NaN;
  if (Number.isFinite(n)) {
    if (n >= 12) return 'Principal';
    if (n >= 8) return 'Staff';
    if (n >= 4) return 'Senior';
    return '';
  }
  if (/\bsenior\b/i.test(text)) return 'Senior';
  return '';
}

function cleanQueries(raw: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of raw) {
    const trimmed = q
      // Operators would collide with the caller's own domain filtering.
      .replace(/\b(site|inurl|intitle|filetype):\S+/gi, '')
      .replace(/["']/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_QUERY_LENGTH);
    if (trimmed.length < 3) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

const dedupe = (xs: string[]): string[] => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Does a posting we found incidentally look like something this candidate
 * asked for?
 *
 * Hydrating one board returns every opening at that company, which is a gift
 * for coverage and a disaster for a triage queue: search for a backend role at
 * a 2,000-person company and you get their recruiters, their warehouse staff
 * and their VP of Sales. The postings that matched the search are always kept;
 * their siblings have to look like one of the planned role titles.
 */
export function titleMatchesPlan(title: string, roleTitles: string[]): boolean {
  if (!roleTitles.length) return false;
  const titleTokens = new Set(tokenize(normalizeLabel(title)));
  const normalisedTitle = normalizeLabel(title);

  return roleTitles.some((role) => {
    const roleTokens = tokenize(normalizeLabel(role));
    const distinctive = roleTokens.filter((t) => !GENERIC_TITLE_TOKENS.has(t));
    const kind = roleTokens.filter((t) => GENERIC_TITLE_TOKENS.has(t));

    // Every token was generic ("Software Engineer"), so token matching would
    // wave through the entire company. Fall back to the phrase itself.
    if (!distinctive.length) return normalisedTitle.includes(normalizeLabel(role));

    // The distinctive words all have to be there...
    if (!distinctive.every((t) => titleTokens.has(t))) return false;

    // ...and so does the kind of job, when the role title said what kind.
    //
    // Without this, planning for "Staff Software Engineer, Payments" matches
    // Mercury's "Counsel, Product & Regulatory - Payments & AML" on the single
    // word "payments" - a lawyer's job, offered to an engineer. Checked
    // against that company's real board: the domain word is shared by roles
    // across the whole org, and the role word is what separates them.
    if (!kind.length) return true;
    return kind.some((t) => titleTokens.has(t));
  });
}

/**
 * Words that appear in most titles of a given kind, and so separate nothing
 * on their own - but do say what kind of job it is.
 */
const GENERIC_TITLE_TOKENS = new Set([
  'engineer', 'engineering', 'software', 'developer', 'senior', 'staff', 'lead',
  'principal', 'junior', 'mid', 'level', 'ii', 'iii', 'iv',
]);
