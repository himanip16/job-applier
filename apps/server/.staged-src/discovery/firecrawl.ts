import { config } from '../lib/config.js';

/**
 * A thin client for Firecrawl's search endpoint.
 *
 * This is the piece that removes "which company should I crawl?" from the
 * setup. The board APIs in sources.ts are excellent at answering *what is open
 * at Acme*, and useless at answering *who is hiring someone like me* - they
 * take a slug you have to already know. Web search answers the second
 * question, and Firecrawl's does it with domain filters and without us running
 * a scraper against Google.
 *
 * Only /v2/search is used. Firecrawl can also fetch page content, but for the
 * job boards we support that would be the wrong tool: once search has told us
 * *which* board a posting lives on, the board's own JSON API gives us the full
 * description, the real location and the posting date, for free and without a
 * parse step. Search finds the door; sources.ts walks through it.
 */

export interface SearchHit {
  url: string;
  title: string;
  description: string;
}

export interface SearchResponse {
  hits: SearchHit[];
  creditsUsed: number;
  warning?: string;
}

export class FirecrawlError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when retrying later might work; false when the config is wrong. */
    readonly transient = false,
  ) {
    super(message);
    this.name = 'FirecrawlError';
  }
}

export const isFirecrawlConfigured = (): boolean => Boolean(config.firecrawlApiKey);

export interface SearchOptions {
  /** Hostnames only, no scheme or path. */
  includeDomains?: string[];
  limit?: number;
  /** ISO-2, for geo-targeting. */
  country?: string;
  /** Firecrawl's time filter: qdr:d / qdr:w / qdr:m / qdr:y. */
  tbs?: string;
  signal?: AbortSignal;
}

/** Firecrawl caps queries at 500 characters and rejects longer ones outright. */
export const MAX_QUERY_LENGTH = 500;

export async function firecrawlSearch(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  if (!config.firecrawlApiKey) {
    throw new FirecrawlError(
      'No Firecrawl key configured. Get one at firecrawl.dev and add it on the Settings page.',
    );
  }

  const body: Record<string, unknown> = {
    query: query.slice(0, MAX_QUERY_LENGTH),
    limit: opts.limit ?? 10,
    // Postings that have been open for a year are usually stale or evergreen
    // reqs that never close. Default to the last month.
    tbs: opts.tbs ?? 'qdr:m',
    country: opts.country ?? 'US',
    // Drop results that other Firecrawl endpoints could not fetch. Costs
    // nothing here and keeps dead URLs out of the queue.
    ignoreInvalidURLs: true,
  };
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;

  let res: Response;
  try {
    res = await fetch(`${config.firecrawlBaseUrl}/v2/search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.firecrawlApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new FirecrawlError(`Could not reach Firecrawl: ${(err as Error).message}`, undefined, true);
  }

  if (!res.ok) throw describeHttpFailure(res.status, await res.text().catch(() => ''));

  const data = (await res.json()) as {
    success?: boolean;
    error?: string;
    warning?: string;
    creditsUsed?: number;
    data?: { web?: { url?: string; title?: string; description?: string }[] };
  };

  if (data.success === false) {
    throw new FirecrawlError(`Firecrawl refused the search: ${data.error ?? 'no reason given'}`);
  }

  const hits: SearchHit[] = (data.data?.web ?? [])
    .filter((h): h is { url: string } & typeof h => typeof h.url === 'string' && h.url.length > 0)
    .map((h) => ({
      url: h.url,
      title: h.title ?? '',
      description: h.description ?? '',
    }));

  return { hits, creditsUsed: data.creditsUsed ?? 0, warning: data.warning };
}

/**
 * Turn an HTTP status into something worth reading.
 *
 * The distinction that matters to a caller is whether waiting helps. An
 * exhausted credit balance and a rate limit both come back as failures, and
 * retrying one of them is pointless.
 */
function describeHttpFailure(status: number, bodyText: string): FirecrawlError {
  const detail = extractError(bodyText);
  const suffix = detail ? ` (${detail})` : '';
  switch (status) {
    case 401:
    case 403:
      return new FirecrawlError(
        `Firecrawl rejected the API key${suffix}. Check your key on the Settings page.`,
        status,
      );
    case 402:
      return new FirecrawlError(
        `Firecrawl is out of credits${suffix}. Top up at firecrawl.dev, or search less often - ` +
          'each query costs roughly two credits.',
        status,
      );
    case 429:
      return new FirecrawlError(
        `Firecrawl rate-limited the search${suffix}. Wait a minute and try again.`,
        status,
        true,
      );
    case 408:
    case 504:
      return new FirecrawlError(`Firecrawl timed out${suffix}. Try again.`, status, true);
    default:
      return new FirecrawlError(
        `Firecrawl returned ${status}${suffix}.`,
        status,
        status >= 500,
      );
  }
}

function extractError(bodyText: string): string {
  if (!bodyText) return '';
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
    const value = parsed.error ?? parsed.message;
    if (typeof value === 'string') return value.slice(0, 200);
  } catch {
    // Not JSON. The raw body is still more useful than nothing.
  }
  return bodyText.replace(/\s+/g, ' ').slice(0, 200);
}
