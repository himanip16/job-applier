import type { Page } from 'playwright';
import type { Blocker } from './blockerTypes.js';

export interface AuthSignals {
  login: boolean;
  createAccount: boolean;
  emailVerification: boolean;
  assessment: boolean;
  accessDenied: boolean;
}

/**
 * An application that makes the site account as part of itself, with its
 * password boxes empty: SuccessFactors' quick apply (`fbclc_*` account boxes
 * under the same Apply button as the application). Not a wall in front of the
 * form - the boxes are filled, then the rest of the form is.
 */
export async function inlineAccountPending(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      if (!document.querySelector('#fbqa_apply')) return false;
      const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[name^="fbclc_pwd"]'));
      return boxes.length > 0 && boxes.some((b) => !b.value);
    })
    .catch(() => false);
}

/**
 * Detect authentication-related blockers on the page.
 */
export async function detectAuthWalls(page: Page): Promise<Blocker[]> {
  const found: Blocker[] = [];

  /**
   * Redirected to somebody's identity provider.
   *
   * The cheapest and most reliable login signal there is, and the only one
   * that catches the common case: Google Careers sends you to
   * accounts.google.com, whose first screen asks for an email address and
   * nothing else. There is no password box to find and no "sign in to apply"
   * text - just a different host. Checked against the live page.
   *
   * Identity vendors' tenants live on subdomains (acme.okta.com), but the
   * vendors hire too: www.okta.com/company/careers is an ordinary application
   * form, and matching `*.okta.com` parked every Okta job at a sign-in wall
   * that was never there. So `www.` is not a tenant.
   */
  const identityHost =
    /^(accounts\.google\.com|idmsa\.apple\.com|login\.microsoftonline\.com|login\.live\.com|signin\.aws\.amazon\.com|github\.com\/login|(?!www\.)(?:[^.]+\.)+(okta|oktapreview|auth0|onelogin|pingidentity)\.com)$/i;

  let host = '';
  try {
    host = new URL(page.url()).hostname;
  } catch {
    host = '';
  }
  const onIdentityProvider = identityHost.test(host);

  const signals = await page.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() ?? '';
    const has = (re: RegExp) => re.test(text);

    /**
     * A password box you can actually see.
     *
     * Presence in the DOM is not enough. Applications that render every screen
     * up front and hide all but one keep the sign-in fields mounted for the
     * whole session, so a plain querySelector reports a login wall on every
     * step - including the ones after you have signed in, which leaves the run
     * stuck at a wall it already cleared.
     */
    const visiblePassword = Array.from(
      document.querySelectorAll<HTMLElement>('input[type="password"]'),
    ).some((el) =>
      typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null,
    );

    // SuccessFactors' quick apply puts "Choose Password" on the application
    // itself, beside Country, Mobile Phone and the rest, under one Apply
    // button. Read as a wall, the run filled the email and passwords, ticked
    // every box on the page (the marketing opt-in too), found no Create
    // Account button and paused with the application itself still blank.
    // Those boxes are fields of this form; see inlineAccountPending.
    const inlineAccount = !!document.querySelector('#fbqa_apply') && !!document.querySelector('input[name="fbclc_pwd"]');

    return {
      login:
        (visiblePassword && !inlineAccount) ||
        has(/sign in to (continue|apply)/) ||
        has(/log ?in to your account/) ||
        has(/(log ?in|sign ?in) or (create|register) (an )?account/) ||
        // Google's first sign-in screen is an email box and this sentence.
        has(/use your google account/) ||
        has(/sign in with your (work|school|microsoft|google) account/) ||
        // Eightfold's candidate modal (Microsoft Careers): a row of
        // "Sign in using Microsoft / LinkedIn / Google" buttons, no password box.
        has(/select a method below to sign in/) ||
        // Workday's sign-in chooser: Google / LinkedIn / "Sign in with email",
        // no password box until one is picked.
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-automation-id="signInContent"], [data-automation-id="SignInWithEmailButton"]',
          ),
        ).some((el) =>
          typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null,
        ),
      createAccount:
        has(/create (an )?account to apply/) ||
        has(/register to (continue|apply)/) ||
        (visiblePassword && !inlineAccount && has(/confirm password/)),
      emailVerification:
        has(/verify your email/) ||
        has(/we sent (you )?a (verification )?(code|link)/) ||
        has(/enter the (6|four|six)[- ]digit code/) ||
        has(/confirm your identity/) ||
        has(/(enter|type) the (verification |security |one[- ]time )?(code|pin) (we|that we) (just )?(sent|emailed)/) ||
        has(/we('ve| have)? (just )?(sent|emailed) (a |an |the )?(verification |security |one[- ]time )?(code|pin) to/) ||
        // SuccessFactors after Create Account: "We've sent a one-time password
        // to your email address" over a Passcode box.
        has(/we(['']ve| have)? (just )?(sent|emailed) (you )?(a |an )?(one[- ]time (password|passcode)|passcode) to/),
      assessment:
        has(/coding (challenge|assessment)/) ||
        has(/complete (a|the) assessment/) ||
        has(/hackerrank|codility|karat/),
      accessDenied:
        has(/access denied/) ||
        has(/unusual traffic/) ||
        has(/are you a robot/) ||
        has(/request blocked/),
    };
  });

  if (signals.accessDenied) {
    found.push({
      kind: 'UNKNOWN',
      detail: 'The site served a bot-detection interstitial rather than the form.',
      humanCanClear: true,
    });
  }
  if (onIdentityProvider) {
    found.push({
      kind: 'LOGIN_REQUIRED',
      detail:
        `This application handed off to ${host} to sign in. Do it once in the open browser - the ` +
        'session profile keeps you signed in for every later application on the same site.',
      humanCanClear: true,
    });
  } else if (signals.createAccount) {
    found.push({
      kind: 'ACCOUNT_CREATION',
      detail: 'This ATS requires an account before it will accept an application.',
      humanCanClear: true,
    });
  } else if (signals.login) {
    found.push({
      kind: 'LOGIN_REQUIRED',
      detail: 'A sign-in is required. Log in once in the visible browser; the session profile keeps you signed in afterwards.',
      humanCanClear: true,
    });
  }
  if (signals.emailVerification) {
    found.push({
      kind: 'EMAIL_VERIFICATION',
      detail: 'A code or link was sent to your inbox and has to be entered by you.',
      humanCanClear: true,
    });
  }
  if (signals.assessment) {
    found.push({
      kind: 'ASSESSMENT',
      detail: 'This application includes a timed assessment. That is yours to do.',
      humanCanClear: true,
    });
  }

  return found;
}
