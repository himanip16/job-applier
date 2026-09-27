/**
 * Every request a source makes, in one place.
 *
 * The board APIs are happy with an honest user agent; several big-company
 * careers sites refuse anything that is not a browser, so those calls send
 * one. A 429 or 503 is waited out once rather than failing the whole company:
 * reading fifty sites in one run is exactly when a rate limit gets hit.
 */

export const UA = 'job-applier/0.1 (personal job search assistant)';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Init = { method?: string; headers?: Record<string, string>; body?: string };

async function request(url: string, init: Init, retries = 1): Promise<Response> {
  const res = await fetch(url, init);
  if ((res.status === 429 || res.status === 503) && retries > 0) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 5, 30) * 1000;
    await sleep(wait);
    return request(url, init, retries - 1);
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
