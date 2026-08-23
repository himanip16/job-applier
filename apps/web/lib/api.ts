export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  /**
   * Only declare a JSON body when there is one.
   *
   * Sending `Content-Type: application/json` with no body makes Fastify reject
   * the request outright with FST_ERR_CTP_EMPTY_JSON_BODY, before any route
   * runs. Every no-body POST in this app - Apply, Save, and the rest - was
   * failing that way, and the 400 it produces has no `error` field, so the UI
   * rendered a bare "Bad Request" and the click looked like it did nothing.
   */
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body !== undefined && init.body !== null) {
    headers['Content-Type'] ??= 'application/json';
  }

  /**
   * Always send the session cookie.
   *
   * The API is on a different origin to the web app - Render and Vercel in
   * production, two ports in development - and a cross-origin fetch omits
   * cookies unless it is told not to. Without this every request arrives
   * signed out, which looks exactly like a broken login.
   */
  const res = await fetch(`${API}${path}`, { ...init, headers, credentials: 'include' });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };

  if (res.status === 401 && typeof window !== 'undefined') {
    // The session went away - expired, signed out in another tab, or the
    // server restarted against a fresh database. Send them to sign in rather
    // than showing "Sign in to use this" in place of every panel.
    const here = window.location.pathname + window.location.search;
    if (!window.location.pathname.startsWith('/signin')) {
      window.location.href = `/signin?next=${encodeURIComponent(here)}`;
    }
  }

  if (!res.ok) {
    // `error` is ours; `message` is what the framework produces for things
    // like a malformed body. Falling back to the status alone loses the only
    // sentence that says what went wrong.
    throw new Error(body.error ?? body.message ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}
