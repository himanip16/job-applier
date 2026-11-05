import type { Page } from 'playwright';

/**
 * Session management utilities for browser automation.
 *
 * Handles checking for active session cookies in the persistent browser profile,
 * enabling instant sign-in via SSO providers when sessions already exist.
 */

/**
 * Provider domains for session checking.
 */
const PROVIDER_DOMAINS = {
  google: ['accounts.google.com', '.google.com'],
  linkedin: ['linkedin.com', '.linkedin.com'],
  microsoft: ['login.live.com', 'login.microsoftonline.com', '.microsoft.com'],
} as const;

export type SessionProvider = keyof typeof PROVIDER_DOMAINS;

/**
 * Check if the persistent profile has active session cookies for a provider.
 *
 * This allows instant sign-in via Google/LinkedIn buttons when the user is
 * already logged in to those services in the browser profile, avoiding
 * credential prompts and 2FA challenges.
 */
export async function hasActiveSession(page: Page, provider: SessionProvider): Promise<boolean> {
  const domains = PROVIDER_DOMAINS[provider];
  const cookies = await page.context().cookies();
  return cookies.some((c) =>
    domains.some((d) => c.domain === d || c.domain.endsWith(d)) && c.name !== '',
  );
}

/**
 * Get all provider names that have active sessions.
 */
export async function getActiveProviders(page: Page): Promise<SessionProvider[]> {
  const providers: SessionProvider[] = [];
  for (const provider of Object.keys(PROVIDER_DOMAINS) as SessionProvider[]) {
    if (await hasActiveSession(page, provider)) {
      providers.push(provider);
    }
  }
  return providers;
}
