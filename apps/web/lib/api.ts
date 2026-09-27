// Use relative URLs in development for Next.js rewrites (same-origin cookies)
// Use absolute URL in production for cross-origin deployment
export const API = process.env.NEXT_PUBLIC_API_URL ?? '';

// Rate limit modal trigger - will be set by the ErrorProvider
let showRateLimitModal: ((provider: 'anthropic' | 'gemini' | null, message: string) => void) | null = null;

export function setRateLimitModalHandler(handler: (provider: 'anthropic' | 'gemini' | null, message: string) => void) {
  showRateLimitModal = handler;
}

/** An error from our API, carrying its machine-readable `code` when it has one. */
export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
  }
}

/** No profile yet: a page should offer to set one up, not report a failure. */
export const needsProfile = (err: unknown) => err instanceof ApiError && err.code === 'PROFILE_REQUIRED';

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
  const headers = new Headers(init?.headers);

  if (
    init?.body !== undefined &&
    init.body !== null &&
    !(init.body instanceof FormData)
  ) {
    headers.set('Content-Type', 'application/json');
  }

  /**
   * Always send the session cookie.
   *
   * In production, the API is on a different origin (Render and Vercel),
   * so cross-origin fetch requires credentials to include cookies.
   * In development, Next.js rewrites proxy requests through the same origin,
   * making cookies work naturally with SameSite=Lax.
   */
  const url = API ? `${API}${path}` : path;
  const res = await fetch(url, { ...init, headers, credentials: 'include' });
  
  const raw = await res.json().catch(() => null);

  const body =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as {
          error?: string;
          message?: string;
          code?: string;
        })
      : {};

  // Only redirect on 401 if it's an authentication requirement, not a failed auth attempt
  if (res.status === 401 && body.code === 'AUTH_REQUIRED' && typeof window !== 'undefined') {
    // The session went away - expired, signed out in another tab, or the
    // server restarted against a fresh database. Send them to sign in rather
    // than showing "Sign in to use this" in place of every panel.
    const here = window.location.pathname + window.location.search;
    // Exclude password reset pages from next parameter to prevent redirect loops
    const isResetPage = window.location.pathname.startsWith('/reset-');
    if (!window.location.pathname.startsWith('/signin') && !isResetPage) {
      window.location.href = `/signin?next=${encodeURIComponent(here)}`;
    } else if (isResetPage) {
      // For reset pages, redirect to signin without next parameter
      window.location.href = '/signin';
    }
  }

  if (!res.ok) {
    // Check for rate limit errors (429) and trigger modal
    if (res.status === 429 && showRateLimitModal) {
      // Determine which provider based on error message
      let provider: 'anthropic' | 'gemini' | null = null;
      const errorMessage = body.error ?? body.message ?? '';

      if (errorMessage.toLowerCase().includes('anthropic')) {
        provider = 'anthropic';
      } else if (errorMessage.toLowerCase().includes('gemini')) {
        provider = 'gemini';
      }

      showRateLimitModal(provider, errorMessage);
    }

    // `error` is ours; `message` is what the framework produces for things
    // like a malformed body. Falling back to the status alone loses the only
    // sentence that says what went wrong.
    throw new ApiError(body.error ?? body.message ?? `${res.status} ${res.statusText}`, body.code, res.status);
  }
  return raw as T;
}
