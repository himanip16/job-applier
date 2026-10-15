/**
 * Whether one posting is still open, read from the posting's own page.
 *
 * The re-check can tell a Greenhouse, Lever, Ashby or Workable job has closed
 * by its absence from the board, because those boards list every opening. The
 * careers-site crawlers and web search read a capped slice, so absence there
 * means nothing, and those leads used to stay in the queue forever. For them
 * the only evidence is the posting itself: a 404, a redirect back to the job
 * search, a "no longer accepting applications" banner, or a JobPosting block
 * whose validThrough has passed.
 *
 * Anything short of that is "unknown", and an unknown lead is kept: most big
 * careers sites render client-side, so the HTML of a live posting and a dead
 * one can be the same empty shell, and dropping a live opening costs more
 * than showing a closed one.
 */

export type PostingStatus = 'open' | 'closed' | 'unknown';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const TIMEOUT_MS = 15_000;

/** What closed postings say on the page, across the sites seen so far. */
const CLOSED_TEXT = [
  /no longer (?:accepting|taking) applications/i,
  /(?:job|position|posting|opening|role|requisition|vacancy)(?: you(?:'re| are) looking for)? (?:is|has been) no longer (?:available|open|active|posted)/i,
  /(?:job|position|posting|opening|role|requisition|vacancy) (?:has|have) (?:been )?(?:closed|filled|expired|removed|archived)/i,
  /(?:job|position|posting|opening|role|requisition|vacancy) (?:is|was) (?:closed|filled|expired)/i,
  /(?:this|the) (?:job|position|posting|opening|role) (?:does not|doesn't|no longer) exists?/i,
  /applications (?:for this (?:job|role|position) )?(?:are|have) (?:now )?closed/i,
  /job (?:not found|expired)/i,
  /this job is unavailable/i,
];

/** Whether a page's visible text says the posting has closed. */
export function saysClosed(text: string): boolean {
  const flat = text.replace(/\s+/g, ' ');
  return CLOSED_TEXT.some((re) => re.test(flat));
}

/** Paths a careers site bounces a dead posting to. */
const LISTING_PATH = /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?\/)?(?:(?:jobs?|careers?|search|search-jobs|job-search|openings|positions|results)\/?)*$/i;
const ERROR_PATH = /(?:not-?found|404|error|expired|unavailable|job-closed|closed)/i;

export async function postingStatus(url: string): Promise<PostingStatus> {
  const workday = workdayApiUrl(url);
  if (workday) return workdayStatus(workday);

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
  } catch {
    return 'unknown';
  }
  if (res.status === 404 || res.status === 410) return 'closed';
  if (!res.ok) return 'unknown';

  if (res.redirected && bouncedAway(url, res.url)) return 'closed';

  let html: string;
  try {
    html = await res.text();
  } catch {
    return 'unknown';
  }
  if (expiredByLd(html)) return 'closed';
  const text = visibleText(html);
  if (saysClosed(text)) return 'closed';
  return 'open';
}

/** A redirect that lost the posting: to the job search, a careers root, or an error page. */
function bouncedAway(from: string, to: string): boolean {
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (ERROR_PATH.test(b.pathname) && !ERROR_PATH.test(a.pathname)) return true;
    // Same posting under a new slug or locale keeps its id somewhere in the URL.
    const id = postingId(a);
    if (id && (b.pathname + b.search + b.hash).includes(id)) return false;
    return LISTING_PATH.test(b.pathname) && !LISTING_PATH.test(a.pathname);
  } catch {
    return false;
  }
}

/** The longest run of digits (or a requisition code) in a posting URL, if any. */
function postingId(url: URL): string | undefined {
  const s = url.pathname + url.search + url.hash;
  const ids = s.match(/[A-Z]{1,4}[-_]?\d{3,}|\d{4,}/gi) ?? [];
  return ids.sort((x, y) => y.length - x.length)[0];
}

/** A JobPosting block whose validThrough is in the past. */
function expiredByLd(html: string, now = Date.now()): boolean {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const found = m[1]!.match(/"validThrough"\s*:\s*"([^"]+)"/);
    if (!found) continue;
    const t = Date.parse(found[1]!);
    // Some sites stamp validThrough at posting time and never move it; only a
    // date well past counts, so a lagging feed does not close a live job.
    if (!Number.isNaN(t) && now - t > 2 * 86_400_000) return true;
  }
  return false;
}

/** The page's text, without scripts, styles or tags, so a closed-posting phrase in a JS bundle does not count. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ');
}

/**
 * Workday pages are an empty shell for live and dead postings alike, but the
 * JSON API behind them answers a closed posting with a 404.
 * `https://t.wd5.myworkdayjobs.com/[en-US/]Site/job/...` -> `/wday/cxs/t/Site/job/...`.
 */
export function workdayApiUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    const host = u.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    if (!host) return undefined;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts.shift();
    const [site, ...rest] = parts;
    if (!site || rest[0] !== 'job') return undefined;
    return `${u.origin}/wday/cxs/${host[1]}/${site}/${rest.join('/')}`;
  } catch {
    return undefined;
  }
}

async function workdayStatus(api: string): Promise<PostingStatus> {
  try {
    const res = await fetch(api, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': BROWSER_UA },
    });
    if (res.status === 404 || res.status === 410) return 'closed';
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as { jobPostingInfo?: unknown };
    return body.jobPostingInfo ? 'open' : 'closed';
  } catch {
    return 'unknown';
  }
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
