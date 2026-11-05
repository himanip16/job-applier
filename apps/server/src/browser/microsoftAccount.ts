import type { Page } from 'playwright';

/**
 * Signing in to Microsoft Careers with the saved Microsoft account or via SSO fallback.
 *
 * Microsoft Careers is an Eightfold tenant (see ats/adapters/microsoft.ts).
 * Its apply page puts a candidate sign-in modal in front of everything. As
 * pasted from the live page in October 2026:
 *
 *   - `[data-testid="auth-entry-container"]`, headed "Sign in", inside a
 *     `candidateAuthV2Modal` dialog: "Select a method below to Sign in";
 *   - one pill button per provider, told apart by class:
 *     `.candidateAuthMicrosoftLoginButton` ("Sign in using Microsoft"),
 *     `...LinkedinLoginButton`, `...GoogleLoginButton`, `...FacebookLoginButton`;
 *   - "First time here? Create an account" (`.linkButton-2njJb`) - transforms
 *     the modal into native email/password fields
 *
 * The Microsoft button hands off to Microsoft's own sign-in (login.live.com
 * for a personal account, login.microsoftonline.com for a work one), in this
 * tab or a popup. Its screens below were not seen from this app. They are
 * Microsoft's long-standing ids plus the newer layout's, so both are tried:
 *
 *   - email: `input[name="loginfmt"]` / `#usernameEntry`, then Next;
 *   - password: `input[name="passwd"]` / `#passwordEntry`, then Sign in. An
 *     account set to passwordless shows a code or an Authenticator prompt
 *     first, with a "Use your password" way out;
 *   - "Stay signed in?": Yes, so the run browser's profile keeps the session
 *     and later Microsoft applications skip all of this.
 *
 * When no Microsoft credentials are saved, this module now:
 *   - Checks for existing Google/LinkedIn sessions in the persistent profile
 *   - Attempts instant sign-in via those SSO buttons if sessions exist
 *   - Falls back to "Create an account" to switch to native email/password flow
 *
 * The Microsoft button hands off to Microsoft's own sign-in (login.live.com
 * for a personal account, login.microsoftonline.com for a work one), in this
 * tab or a popup. Its screens below were not seen from this app. They are
 * Microsoft's long-standing ids plus the newer layout's, so both are tried:
 *
 *   - email: `input[name="loginfmt"]` / `#usernameEntry`, then Next;
 *   - password: `input[name="passwd"]` / `#passwordEntry`, then Sign in. An
 *     account set to passwordless shows a code or an Authenticator prompt
 *     first, with a "Use your password" way out;
 *   - "Stay signed in?": Yes, so the run browser's profile keeps the session
 *     and later Microsoft applications skip all of this.
 *
 * A code sent to email or phone, or an Authenticator approval, stays with you:
 * the run stops there like any sign-in wall, and carries on by itself once the
 * page is back on Microsoft Careers.
 *
 * Plain DOM work, like accountWall.ts and appleId.ts: no model sees the page,
 * and the password goes nowhere but Microsoft's own password box.
 */

export interface MicrosoftAccount {
  email: string;
  password: string;
}

export interface MicrosoftAttempt {
  outcome: 'signed-in' | 'needs-you' | 'failed';
  detail: string;
}

export interface MicrosoftSignInOptions {
  /** Allow fallback to Google/LinkedIn SSO using existing sessions */
  allowSsoFallback?: boolean;
  /** Allow fallback to native account creation (email/password) */
  allowNativeFallback?: boolean;
}

const CAREERS_HOST = /(^|\.)careers\.microsoft\.com$/i;
const LOGIN_HOST = /^(login\.live\.com|login\.microsoftonline\.com|account\.live\.com|account\.microsoft\.com)$/i;

const MODAL = '[data-testid="auth-entry-container"]';
const MODAL_CONTAINER = '.candidateAuthV2Modal';
const MICROSOFT_BUTTON = '.candidateAuthMicrosoftLoginButton';
const GOOGLE_BUTTON = '.candidateAuthGoogleLoginButton';
const LINKEDIN_BUTTON = '.candidateAuthLinkedinLoginButton';
const CREATE_ACCOUNT_BUTTON = '.linkButton-2njJb';

const EMAIL_BOX = 'input[name="loginfmt"]:visible, #usernameEntry:visible, input[type="email"]:visible';
const PASSWORD_BOX = 'input[name="passwd"]:visible, #passwordEntry:visible, input[type="password"]:visible';
/** Next / Sign in / Yes: one id in the old layout, a submit button in the new. */
const PRIMARY = '#idSIButton9:visible, button[data-testid="primaryButton"]:visible, button[type="submit"]:visible, input[type="submit"]:visible';

const USE_PASSWORD = /use (your|a) password( instead)?/i;
const STAY_SIGNED_IN = /stay signed in\?/i;
/** Screens that need something only you have. */
const NEEDS_YOU =
  /enter (the )?code|verify your (email|identity|phone)|approve (the )?sign[- ]?in request|check your authenticator|we('ve| have)? sent a code|help us protect your account|use your face, fingerprint|security key|passkey/i;
const REFUSED =
  /doesn't exist|does not exist|isn't valid|is not valid|incorrect|account (has been |is )?(locked|blocked|suspended)|too many|try again later|couldn't find an account/i;

/**
 * Check if the persistent profile has active session cookies for a provider.
 *
 * This allows instant sign-in via Google/LinkedIn buttons when the user is
 * already logged in to those services in the browser profile, avoiding
 * credential prompts and 2FA challenges.
 */
async function hasActiveSession(page: Page, provider: 'google' | 'linkedin' | 'microsoft'): Promise<boolean> {
  const domains = {
    google: ['accounts.google.com', '.google.com'],
    linkedin: ['linkedin.com', '.linkedin.com'],
    microsoft: ['login.live.com', 'login.microsoftonline.com', '.microsoft.com'],
  };
  const cookies = await page.context().cookies();
  return cookies.some((c) =>
    domains[provider].some((d) => c.domain === d || c.domain.endsWith(d)) && c.name !== '',
  );
}

/**
 * Try signing in via Google or LinkedIn using an existing session.
 *
 * Returns true if the button was clicked and the modal cleared (either by
 * instant redirect or by the user completing a quick auth flow in a popup).
 */
async function trySsoWithExistingSession(
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
    if (!(await page.locator(MODAL).first().isVisible().catch(() => false))) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }

    await page.waitForTimeout(500).catch(() => {});
  }

  return false;
}

/**
 * Click "Create an account" to switch to native email/password flow.
 *
 * This transforms the modal into standard account creation fields that can
 * be handled by accountWall.ts using JOB_SITE_PASSWORD.
 */
async function switchToNativeAccount(page: Page): Promise<boolean> {
  const button = page.locator(CREATE_ACCOUNT_BUTTON).first();
  if (!(await button.isVisible().catch(() => false))) return false;

  await button.click({ timeout: 5000 });
  await page.waitForTimeout(1000).catch(() => {});

  // Wait for email/password fields to appear
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const hasEmail = await page.locator('input[type="email"]').count().catch(() => 0) > 0;
    const hasPassword = await page.locator('input[type="password"]').count().catch(() => 0) > 0;
    if (hasEmail && hasPassword) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }
    await page.waitForTimeout(500).catch(() => {});
  }

  return false;
}

/**
 * Eightfold's candidate sign-in modal on Microsoft Careers, or Microsoft's own
 * sign-in pages. The modal renders a moment after the page reads as a sign-in
 * wall, so it is waited for rather than glanced at - a glance missed it and the
 * run parked without trying the saved account.
 */
export async function onMicrosoftSignIn(page: Page, waitMs = 8000): Promise<boolean> {
  const host = hostOf(page);
  if (LOGIN_HOST.test(host)) return true;
  if (!CAREERS_HOST.test(host)) return false;
  return page
    .locator(`${MODAL}, ${MICROSOFT_BUTTON}`)
    .first()
    .waitFor({ state: 'visible', timeout: waitMs })
    .then(() => true)
    .catch(() => false);
}

export async function signInWithMicrosoftAccount(
  page: Page,
  account: MicrosoftAccount,
  options?: MicrosoftSignInOptions,
): Promise<MicrosoftAttempt> {
  const allowSso = options?.allowSsoFallback ?? true;
  const allowNative = options?.allowNativeFallback ?? true;

  let login = page;
  if (CAREERS_HOST.test(hostOf(page))) {
    const button = page.locator(MICROSOFT_BUTTON).first();
    if (!(await button.isVisible().catch(() => false))) {
      // Microsoft button not visible - try SSO fallback or native account
      if (allowSso) {
        const hasGoogle = await hasActiveSession(page, 'google');
        const hasLinkedin = await hasActiveSession(page, 'linkedin');

        if (hasGoogle) {
          const googleSuccess = await trySsoWithExistingSession(page, GOOGLE_BUTTON, 'Google');
          if (googleSuccess && (await backOnCareers(page))) {
            return { outcome: 'signed-in', detail: 'Signed in using your existing Google session.' };
          }
        }

        if (hasLinkedin) {
          const linkedinSuccess = await trySsoWithExistingSession(page, LINKEDIN_BUTTON, 'LinkedIn');
          if (linkedinSuccess && (await backOnCareers(page))) {
            return { outcome: 'signed-in', detail: 'Signed in using your existing LinkedIn session.' };
          }
        }
      }

      if (allowNative) {
        const switched = await switchToNativeAccount(page);
        if (switched) {
          return {
            outcome: 'needs-you',
            detail:
              'Switched to native account creation. Use your job site password (JOB_SITE_PASSWORD) to complete the sign-in.',
          };
        }
      }

      return { outcome: 'failed', detail: 'The "Sign in using Microsoft" button is not on the page.' };
    }

    const popup = page.context().waitForEvent('page', { timeout: 20_000 }).catch(() => null);
    await button.click({ timeout: 5000 });
    login = (await handedOffTo(page, popup)) ?? page;
    // Signed in at Microsoft already: the hand-off came straight back.
    if (!LOGIN_HOST.test(hostOf(login))) {
      return (await backOnCareers(page))
        ? signedIn()
        : { outcome: 'failed', detail: 'Pressed "Sign in using Microsoft", but no Microsoft sign-in page opened.' };
    }
  }

  // Up to a dozen screens: email, password, "Stay signed in?", and whatever
  // Microsoft puts between them. Each pass deals with the one showing.
  let typedEmail = false;
  let typedPassword = false;
  for (let step = 0; step < 12; step++) {
    if (login.isClosed() || !LOGIN_HOST.test(hostOf(login))) {
      return (await backOnCareers(page))
        ? signedIn()
        : { outcome: 'failed', detail: 'Left the Microsoft sign-in, but Microsoft Careers still shows its sign-in.' };
    }
    const text = await bodyText(login);
    const refused = text.match(REFUSED);
    if (refused && (typedEmail || typedPassword)) {
      return { outcome: 'failed', detail: `Microsoft refused the sign-in: "${refused[0]}".` };
    }

    if (STAY_SIGNED_IN.test(text)) {
      await login.locator('#KmsiCheckboxField').check({ timeout: 2000 }).catch(() => {});
      await pressPrimary(login);
    } else if (await isVisible(login, PASSWORD_BOX)) {
      if (typedPassword) return stalled(text);
      await login.locator(PASSWORD_BOX).first().fill(account.password);
      typedPassword = true;
      await pressPrimary(login, PASSWORD_BOX);
    } else if (await isVisible(login, EMAIL_BOX)) {
      if (typedEmail) return stalled(text);
      await login.locator(EMAIL_BOX).first().fill(account.email);
      typedEmail = true;
      await pressPrimary(login, EMAIL_BOX);
    } else if (await clickText(login, USE_PASSWORD)) {
      // Passwordless account: Microsoft offers a code first.
    } else if (await clickText(login, new RegExp(escape(account.email), 'i'))) {
      // "Pick an account", with this one remembered.
    } else if (NEEDS_YOU.test(text)) {
      return needsYou(text.match(NEEDS_YOU)![0]);
    } else {
      // Between screens.
    }
    await login.waitForTimeout(1500).catch(() => {});
  }
  return stalled(await bodyText(login));
}

/** The page Microsoft's sign-in opened on: this tab, a popup, or neither. */
async function handedOffTo(page: Page, popup: Promise<Page | null>): Promise<Page | null> {
  const deadline = Date.now() + 20_000;
  const opened: { page: Page | null } = { page: null };
  void popup.then((p) => {
    opened.page = p;
  });
  while (Date.now() < deadline) {
    if (LOGIN_HOST.test(hostOf(page))) return page;
    if (opened.page) {
      await opened.page.waitForLoadState('domcontentloaded').catch(() => {});
      return opened.page;
    }
    if (await backOnCareers(page, 0)) return page;
    await page.waitForTimeout(400).catch(() => {});
  }
  return null;
}

/** On Microsoft Careers with the sign-in modal gone. */
async function backOnCareers(page: Page, waitMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  do {
    if (page.isClosed()) return false;
    if (CAREERS_HOST.test(hostOf(page))) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});

      // Wait for modal to detach (handles async OAuth popup completion)
      const modalDetached = await page
        .locator(MODAL)
        .waitFor({ state: 'detached', timeout: 3000 })
        .then(() => true)
        .catch(() => false);

      if (modalDetached || !(await page.locator(MODAL).first().isVisible().catch(() => false))) {
        // Additional wait for network to settle after OAuth redirect
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        return true;
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(750).catch(() => {});
  } while (Date.now() < deadline);
  return false;
}

async function pressPrimary(page: Page, field?: string): Promise<void> {
  const button = page.locator(PRIMARY).first();
  const clicked = await button
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked && field) await page.locator(field).first().press('Enter').catch(() => {});
}

async function clickText(page: Page, name: RegExp): Promise<boolean> {
  for (const role of ['button', 'link'] as const) {
    const control = page.getByRole(role, { name }).first();
    if (await control.isVisible().catch(() => false)) {
      return control
        .click({ timeout: 3000 })
        .then(() => true)
        .catch(() => false);
    }
  }
  return false;
}

const signedIn = (msg = 'Signed in with your Microsoft account.'): MicrosoftAttempt => ({
  outcome: 'signed-in',
  detail: msg,
});

const needsYou = (what: string): MicrosoftAttempt => ({
  outcome: 'needs-you',
  detail:
    `Microsoft wants something only you have ("${what}"). Finish the sign-in in the open browser window - ` +
    'the run carries on by itself once it is back on Microsoft Careers.',
});

function stalled(text: string): MicrosoftAttempt {
  const need = text.match(NEEDS_YOU);
  if (need) return needsYou(need[0]);
  return {
    outcome: 'failed',
    detail: `The Microsoft sign-in did not move on. It shows: "${text.slice(0, 160)}".`,
  };
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function bodyText(page: Page): Promise<string> {
  return page
    .locator('body')
    .innerText({ timeout: 2000 })
    .then((t) => t.replace(/\s+/g, ' ').trim())
    .catch(() => '');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hostOf(page: Page): string {
  try {
    return new URL(page.url()).hostname;
  } catch {
    return '';
  }
}
