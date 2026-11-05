import type { Page } from 'playwright';
import { clickFirst, clickByName, fillEmail, visibleCount } from './domHelpers';
import { isInlineAccount, isEmailFirst, isSignInScreen } from './formDetector';
import { fillInlineAccount, submitCreate, submitSignIn } from './formFiller';

/**
 * Getting past a job site's own account wall with the saved email and password.
 *
 * Workday and its kind put "Create Account" or "Sign In" in front of every
 * application. Both screens are the same few boxes everywhere - an email, one
 * or two passwords, maybe a consent tick - so this is plain DOM work: no model
 * reads the page and nothing about the password ever leaves this file except
 * into the site's own password box.
 *
 * Only for the site's own accounts. Someone else's identity provider (Google,
 * Microsoft, Okta) is a different trust decision and stays with the person.
 */

export interface SiteAccount {
  email: string;
  password: string;
  /** For Create Account forms that ask for a name (SuccessFactors does). */
  firstName?: string;
  lastName?: string;
  /** Phone without its country code, and the ISO-2 country (SuccessFactors asks both). */
  phone?: string;
  countryCode?: string;
}

export interface AccountAttempt {
  ok: boolean;
  detail: string;
  /** The site answered that this email is already registered. */
  exists?: boolean;
  /** The site turned the email and password down. */
  refused?: boolean;
  /** The account was made and the site moved on to its Sign In screen. */
  signInNext?: boolean;
}

const VISIBLE_PASSWORD = 'input[type="password"]:visible';

const EMAIL_INPUT = [
  'input[data-automation-id="email"]',
  'input[type="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[name*="user" i]',
  'input[id*="user" i]',
]
  .map((s) => `${s}:visible`)
  .join(', ');

const SIGN_IN_LINK ='[data-automation-id="signInLink"]';
const CREATE_LINK = '[data-automation-id="createAccountLink"]';
/** Workday's sign-in chooser: Google / LinkedIn buttons, then "Sign in with email". */
const EMAIL_SIGN_IN_BUTTON = '[data-automation-id="SignInWithEmailButton"]';

const IDENTITY_HOST =
  /(^|\.)(accounts\.google\.com|idmsa\.apple\.com|login\.microsoftonline\.com|login\.live\.com|signin\.aws\.amazon\.com|okta\.com|oktapreview\.com|auth0\.com|onelogin\.com|pingidentity\.com)$/i;

export async function signInOrRegister(page: Page, account: SiteAccount): Promise<AccountAttempt> {
  let host = '';
  try {
    host = new URL(page.url()).hostname;
  } catch {
    host = '';
  }
  if (IDENTITY_HOST.test(host)) {
    return { ok: false, detail: `${host} is a third-party sign-in; that one is yours to do.` };
  }
  if (await isInlineAccount(page)) {
    return fillInlineAccount(page, account);
  }

  // Email-first wall ("Log in or create account": one email box and
  // Continue). The site decides from the email which screen comes next - a
  // password to sign in, or a new password (and confirm) to register.
  let emailEntered = false;
  if (!(await visibleCount(page, VISIBLE_PASSWORD)) && (await isEmailFirst(page))) {
    await fillEmail(page, EMAIL_INPUT, account.email);
    if (!(await clickByName(page, /^(continue|next)$/i))) {
      await page.locator(EMAIL_INPUT).first().press('Enter').catch(() => {});
    }
    await page.locator(VISIBLE_PASSWORD).first().waitFor({ timeout: 15_000 }).catch(() => {});
    if (!(await visibleCount(page, VISIBLE_PASSWORD))) {
      return { ok: false, detail: 'Entered the email and pressed Continue, but no password box followed.' };
    }
    emailEntered = true;
  }

  // A wall with no password box yet: "Sign In" / "Create Account" buttons
  // that open the form. Prefer signing in - an account made on an earlier
  // application is the common case once a few have gone through.
  if (!(await visibleCount(page, VISIBLE_PASSWORD))) {
    const opened =
      // Pick the site's own email sign-in over the Google/LinkedIn buttons.
      (await clickFirst(page, EMAIL_SIGN_IN_BUTTON)) ||
      (await clickByName(page, /^(sign in|log ?in|continue) with email$/i)) ||
      (await clickFirst(page, SIGN_IN_LINK)) ||
      (await clickByName(page, /^(sign in|log ?in)$/i)) ||
      (await clickFirst(page, CREATE_LINK)) ||
      (await clickByName(page, /^(create (an )?account|register|sign up)$/i));
    if (!opened) return { ok: false, detail: 'Could not find the sign-in form on this page.' };
    await page.locator(VISIBLE_PASSWORD).first().waitFor({ timeout: 10_000 }).catch(() => {});
    if (!(await visibleCount(page, VISIBLE_PASSWORD))) {
      return { ok: false, detail: 'Opened the account screen, but no password box appeared.' };
    }
  }

  if ((await visibleCount(page, VISIBLE_PASSWORD)) >= 2) {
    const created = await submitCreate(page, account, emailEntered);
    if (created.ok) return created;
    if (created.signInNext) {
      const signedIn = await submitSignIn(page, account);
      return { ...signedIn, detail: `${created.detail} ${signedIn.detail}` };
    }
    // Made on an earlier application: switch to signing in.
    if (!created.exists) return created;
    const switched =
      (await clickFirst(page, SIGN_IN_LINK)) || (await clickByName(page, /^(sign in|log ?in)$/i));
    if (!switched) return { ok: false, detail: 'An account already exists, but there was no Sign In link to switch to.' };
    // Workday blanks the form while it swaps screens; a fixed pause read that
    // gap as "no email box". Wait for the one-password Sign In form instead.
    await page
      .waitForFunction(
        (sel) => Array.from(document.querySelectorAll(sel)).filter((el) => (el as HTMLElement).checkVisibility()).length === 1,
        'input[type="password"]',
        { timeout: 15_000, polling: 250 },
      )
      .catch(() => {});
    const signedIn = await submitSignIn(page, account, emailEntered);
    return signedIn.ok
      ? signedIn
      : { ...signedIn, detail: `An account with this email already exists, so switched to Sign In. ${signedIn.detail}` };
  }
  const signedIn = await submitSignIn(page, account, emailEntered);
  if (signedIn.ok || !signedIn.refused) return signedIn;
  // "Invalid email or password" is what SuccessFactors says when no account
  // has this email yet. Registering is safe either way: an email that does
  // have an account is turned down with "already exists", and that stops here.
  const opened =
    (await clickFirst(page, CREATE_LINK)) ||
    (await clickByName(page, /^(create (an )?account|register|sign up)$/i));
  if (!opened) return signedIn;
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.locator(VISIBLE_PASSWORD).nth(1).waitFor({ timeout: 15_000 }).catch(() => {});
  const created = (await isInlineAccount(page))
    ? await fillInlineAccount(page, account)
    : (await visibleCount(page, VISIBLE_PASSWORD)) >= 2
      ? await submitCreate(page, account)
      : { ok: false, detail: 'Opened Create Account, but no password boxes appeared.' };
  const after = created.signInNext ? await submitSignIn(page, account) : null;
  return {
    ...created,
    ...after,
    detail: `Sign In refused the saved email and password, so made an account instead. ${created.detail}${after ? ` ${after.detail}` : ''}`,
  };
}
