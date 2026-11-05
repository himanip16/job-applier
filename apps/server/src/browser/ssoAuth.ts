import type { Page } from 'playwright';
import { hostOf } from './domHelpers.js';

/**
 * SSO (Single Sign-On) authentication handling for third-party providers.
 *
 * Handles attempting sign-in via Google, LinkedIn, and other SSO providers
 * using existing browser sessions to avoid credential prompts.
 */

/**
 * Provider button selectors for the Microsoft Careers modal.
 */
export const SSO_BUTTONS = {
  google: '.candidateAuthGoogleLoginButton',
  linkedin: '.candidateAuthLinkedinLoginButton',
} as const;

export type SsoProvider = keyof typeof SSO_BUTTONS;

/**
 * Try signing in via an SSO provider using an existing session.
 *
 * Returns true if the button was clicked and the modal cleared (either by
 * instant redirect or by the user completing a quick auth flow in a popup).
 *
 * @param page - The page with the SSO button
 * @param buttonSelector - CSS selector for the SSO button
 * @param providerName - Human-readable provider name for logging
 */
export async function trySsoWithExistingSession(
  page: Page,
  buttonSelector: string,
  providerName: string,
): Promise<boolean> {
  const button = page.locator(buttonSelector).first();
  if (!(await button.isVisible().catch(() => false))) return false;

  const popup = page.context().waitForEvent('page', { timeout: 20_000 }).catch(() => null);
  await button.click({ timeout: 5000 });

  // Wait for either the popup to appear and return, or the modal to clear directly
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    // If a popup opened, wait for it to close or navigate back
    if (popup) {
      const opened = await Promise.race([popup, Promise.resolve(null)]);
      if (opened) {
        // Popup opened - wait for it to close or navigate back to careers
        try {
          await opened.waitForLoadState('domcontentloaded', { timeout: 10_000 });
          // If popup is on the provider's domain, user is handling auth manually
          const popupHost = hostOf(opened);
          if (popupHost.includes('google') || popupHost.includes('linkedin')) {
            // User is in an auth flow - this will need manual completion
            return false;
          }
        } catch {
          // Popup closed immediately or redirected back
        }
      }
    }

    // Check if modal has cleared
    const modal = page.locator('[data-testid="auth-entry-container"]').first();
    if (!(await modal.isVisible().catch(() => false))) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }

    await page.waitForTimeout(500).catch(() => {});
  }

  return false;
}

/**
 * Attempt SSO sign-in with a specific provider if a session exists.
 *
 * @param page - The page to attempt sign-in on
 * @param provider - The SSO provider to use
 * @param careersHost - Host pattern to match for successful return to careers
 * @returns true if sign-in succeeded, false otherwise
 */
export async function attemptSsoSignIn(
  page: Page,
  provider: SsoProvider,
  careersHost: RegExp,
): Promise<boolean> {
  const { hasActiveSession } = await import('./sessionManager.js');

  if (!(await hasActiveSession(page, provider))) return false;

  const buttonSelector = SSO_BUTTONS[provider];
  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
  const success = await trySsoWithExistingSession(page, buttonSelector, providerName);

  if (success && careersHost.test(hostOf(page))) {
    return true;
  }

  return false;
}
