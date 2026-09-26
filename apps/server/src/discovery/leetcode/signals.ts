/**
 * What LeetCode's discussion boards say about a company: what people there
 * were paid, and whether it is interviewing right now.
 *
 * Nothing here is inferred. A figure is kept only when a post's own labelled
 * line states it ("Base: 43.5 LPA", "Total TC: 37,50,000"), and it is stored
 * with that exact line and the post's link so anyone can check it. A post is
 * attributed to a company only when its title names that company and no other
 * target company - a "Google vs Amazon, which offer?" post is skipped, not
 * guessed at.
 */

const GRAPHQL = 'https://leetcode.com/graphql/';
const HEADERS = {
  'content-type': 'application/json',
  referer: 'https://leetcode.com/discuss/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36',
};

export interface Post {
  topicId: string;
  title: string;
  slug: string;
  createdAt: string;
  url: string;
}

export interface CompFigure {
  post: Post;
  /** As the poster wrote it on a "Title/Level:" line or in the title, if they did. */
  level?: string;
  baseLpa?: number;
  totalLpa?: number;
  /** The lines the numbers were read from, verbatim. */
  evidence: string[];
}

export interface CompanySignals {
  company: string;
  /** Interview-experience posts naming this company alone, newest first. */
  interviews: Post[];
  comp: CompFigure[];
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(GRAPHQL, { method: 'POST', headers: HEADERS, body: JSON.stringify({ query, variables }) });
    if (res.status === 429 && attempt < 2) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from LeetCode`);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(body.errors[0]!.message);
    return body.data!;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Posts in one tag mentioning the keyword, newest first, back to `since`. */
export async function searchPosts(keyword: string, tag: string, since: Date, max = 60): Promise<Post[]> {
  const out: Post[] = [];
  for (let skip = 0; skip < max; skip += 20) {
    const data = await graphql<{
      ugcArticleDiscussionArticles: { edges: { node: { topicId: number; title: string; slug: string; createdAt: string } }[] };
    }>(
      `query q($keywords: [String]!, $tagSlugs: [String!], $skip: Int, $first: Int) {
        ugcArticleDiscussionArticles(orderBy: MOST_RECENT, keywords: $keywords, tagSlugs: $tagSlugs, skip: $skip, first: $first) {
          edges { node { topicId title slug createdAt } }
        }
      }`,
      { keywords: [keyword], tagSlugs: [tag], skip, first: 20 },
    );
    const page = data.ugcArticleDiscussionArticles.edges.map(({ node: n }) => ({
      topicId: String(n.topicId),
      title: n.title,
      slug: n.slug,
      createdAt: n.createdAt,
      url: `https://leetcode.com/discuss/post/${n.topicId}/${n.slug}/`,
    }));
    const fresh = page.filter((p) => new Date(p.createdAt) >= since);
    out.push(...fresh);
    if (page.length < 20 || fresh.length < page.length) break;
    await sleep(400);
  }
  return out;
}

export async function postContent(topicId: string): Promise<string> {
  const data = await graphql<{ ugcArticleDiscussionArticle: { content: string } | null }>(
    'query a($topicId: ID!) { ugcArticleDiscussionArticle(topicId: $topicId) { content } }',
    { topicId },
  );
  return data.ugcArticleDiscussionArticle?.content ?? '';
}

// ------------------------------------------------------------ attribution ---

/** How titles write a company, when not by its list name. Lower case. */
const ALIASES: Record<string, string[]> = {
  Meta: ['meta', 'facebook'],
  'D. E. Shaw India': ['de shaw', 'd.e. shaw', 'd. e. shaw', 'deshaw', 'd e shaw'],
  'Tower Research Capital': ['tower research'],
  'Graviton Research Capital': ['graviton'],
  'IMC Trading': ['imc'],
  'Squarepoint Capital': ['squarepoint'],
  'NK Securities Research': ['nk securities', 'nksr'],
  'AlphaGrep Securities': ['alphagrep', 'alpha grep'],
  'Millennium Management': ['millennium'],
  'Quadeye Securities': ['quadeye'],
  'XTX Markets': ['xtx'],
  'Quantbox Research': ['quantbox'],
  'Mudraksh & McShaw': ['mudraksh'],
  'Dolat Capital': ['dolat'],
  'Arista Networks': ['arista'],
  'Booking.com': ['booking.com', 'booking holdings'],
  'Dream11': ['dream11', 'dream sports', 'dream 11'],
  'Eternal (Zomato/Blinkit)': ['zomato', 'blinkit', 'eternal'],
};

export const namesFor = (company: string): string[] => ALIASES[company] ?? [company.toLowerCase()];

const mentions = (text: string, name: string) =>
  new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(text);

/**
 * A post weighing offers against each other ("Sprinklr vs HighRadius", "Offer
 * evaluation - eBay vs Sprinklr vs Kotak"). Its numbers belong to more than
 * one company and the post does not say which line is whose, so no pay is
 * read from it - even when only one of the companies is on the target list.
 */
export const isComparison = (title: string): boolean =>
  /\b(vs\.?|versus|v\/s|or|compare|comparison|which (offer|one|company)|offer evaluation|evaluate|multiple offers|offers)\b/i.test(title);

/** The one target company a title names, or null if none or several. */
export function soleCompany(title: string, companies: string[]): string | null {
  const named = companies.filter((c) => namesFor(c).some((n) => mentions(title, n)));
  return named.length === 1 ? named[0]! : null;
}

// ------------------------------------------------------------- extraction ---

/**
 * An Indian-rupee amount in lakhs, or null.
 *
 * Accepts the forms people actually write - "43.5 LPA", "₹45 LPA", "33L",
 * "38 lakhs", "23,00,000", "~37,50,000" - and nothing in another currency: a
 * USD or crore figure, or a bare number with no unit, is not guessed at.
 */
export function parseLakhs(text: string): number | null {
  if (/\$|€|£|\b(usd|eur|gbp|sgd|crores?|cr)\b/i.test(text)) return null;
  // "33–38L" or "60-65L" is a hope or a band, not an offer.
  if (/\d\s*[-–—]\s*\d/.test(text) || /\b(expect|expected|expecting|asking|target)\b/i.test(text)) return null;
  const lakhs = text.match(/(\d{1,3}(?:\.\d{1,2})?)\s*(?:lpa|lakhs?|lacs?|l)\b/i);
  if (lakhs) return Number(lakhs[1]);
  // Indian digit grouping: 23,00,000 or 1,23,00,000.
  const grouped = text.match(/(?:₹|rs\.?|inr)?\s*~?\s*(\d{1,3}(?:,\d{2})+,\d{3})\b/i);
  if (grouped) return Number(grouped[1]!.replace(/,/g, '')) / 100_000;
  return null;
}

/** "label: value" lines, as posters format the compensation template. */
const LINE = /^\s*[-*•#]*\s*([A-Za-z /()'.-]{2,40}?)\s*[:\-–=]\s*(.+)$/;
// A bare "Salary:" is left out: posters use it for base and for total alike.
const BASE = /^(base|base salary|base pay|fixed|fixed pay|fixed salary|fixed component)$/i;
const TOTAL = /^(total|tc|ctc|total tc|total ctc|total compensation|total comp|first year total|1st year tc|year 1 tc)$/i;
const LEVEL = /^(title\/level|title|level|role|position|designation)$/i;
const LEVEL_IN_TITLE = /\b(sde|swe|mts|smts|software engineer|sse)\s*[-]?\s*(i{1,3}|[1-3])\b|\bL\d{2}\b|\bL[3-7]\b/i;

export function extractComp(post: Post, content: string): CompFigure | null {
  const figure: CompFigure = { post, evidence: [] };
  for (const raw of content.replace(/\r/g, '').split('\n')) {
    const m = raw.replace(/\*\*/g, '').match(LINE);
    if (!m) continue;
    const label = m[1]!.trim();
    const value = m[2]!.trim();
    if (figure.baseLpa === undefined && BASE.test(label)) {
      const n = parseLakhs(value);
      if (n !== null && n > 0 && n < 500) {
        figure.baseLpa = n;
        figure.evidence.push(raw.trim());
      }
    } else if (figure.totalLpa === undefined && TOTAL.test(label)) {
      const n = parseLakhs(value);
      if (n !== null && n > 0 && n < 1000) {
        figure.totalLpa = n;
        figure.evidence.push(raw.trim());
      }
    } else if (!figure.level && LEVEL.test(label) && value.length <= 60) {
      figure.level = value;
    }
  }
  if (!figure.level) figure.level = post.title.match(LEVEL_IN_TITLE)?.[0];
  return figure.baseLpa !== undefined || figure.totalLpa !== undefined ? figure : null;
}

// ------------------------------------------------------------------ collect ---

export async function collectSignals(
  company: string,
  allCompanies: string[],
  opts: { compSince: Date; interviewSince: Date; maxCompPosts?: number; log?: (m: string) => void },
): Promise<CompanySignals> {
  const out: CompanySignals = { company, interviews: [], comp: [] };
  const keyword = namesFor(company)[0]!;

  const interviewPosts = await searchPosts(keyword, 'interview', opts.interviewSince, 60);
  out.interviews = interviewPosts.filter((p) => soleCompany(p.title, allCompanies) === company);

  const compPosts = (await searchPosts(keyword, 'compensation', opts.compSince, 80))
    .filter((p) => soleCompany(p.title, allCompanies) === company && !isComparison(p.title))
    .slice(0, opts.maxCompPosts ?? 12);
  for (const post of compPosts) {
    await sleep(300);
    try {
      const figure = extractComp(post, await postContent(post.topicId));
      if (figure) out.comp.push(figure);
    } catch (err) {
      opts.log?.(`  ${company}: could not read ${post.url}: ${(err as Error).message}`);
    }
  }
  return out;
}
