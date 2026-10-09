/**
 * Every request a source makes, in one place.
 *
 * The board APIs are happy with an honest user agent; several big-company
 * careers sites refuse anything that is not a browser, so those calls send
 * one. A 429 or 503 is waited out, with a growing pause, rather than failing
 * the whole company: reading fifty sites in one run is exactly when a rate
 * limit gets hit, and most (Microsoft's, for one) clear within half a minute
 * but never say how long to wait.
 */

export const UA = 'job-applier/0.1 (personal job search assistant)';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Init = { method?: string; headers?: Record<string, string>; body?: string };

/** Seconds to wait before each retry when the site does not say. */
const BACKOFF_S = [5, 15, 30];

async function request(url: string, init: Init, attempt = 0): Promise<Response> {
  const res = await fetch(url, init);
  if ((res.status === 429 || res.status === 503) && attempt < BACKOFF_S.length) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || BACKOFF_S[attempt]!, 60) * 1000;
    await sleep(wait);
    return request(url, init, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return res;
}

/** JSON from a public API that is fine being asked by name. */
export async function getJson<T>(url: string): Promise<T> {
  return (await request(url, { headers: { accept: 'application/json', 'user-agent': UA } })).json() as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return (await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
  })).json() as Promise<T>;
}

/** A page as a browser would get it. */
export async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  return (await request(url, { headers: { 'user-agent': BROWSER_UA, ...headers } })).text();
}

/** JSON as a browser would get it. */
export async function getBrowserJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return (await request(url, { headers: { 'user-agent': BROWSER_UA, accept: 'application/json', ...headers } })).json() as Promise<T>;
}

/**
 * A page as a browser's own top-level navigation would request it. Meta's
 * careers site answers anything without these fetch-metadata headers with a 400.
 */
export async function getBrowserPage(url: string): Promise<string> {
  return getText(url, {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  });
}

/** A form POST from the page itself, answered with JSON. */
export async function postForm<T>(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<T> {
  return (await request(url, {
    method: 'POST',
    headers: {
      'user-agent': BROWSER_UA,
      'content-type': 'application/x-www-form-urlencoded',
      accept: '*/*',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: new URLSearchParams(form).toString(),
  })).json() as Promise<T>;
}
