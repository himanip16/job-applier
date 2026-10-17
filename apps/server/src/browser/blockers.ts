import type { Page } from 'playwright';
import type { BlockerKind } from '@ja/shared';
import { evaluatePage } from './evaluate.js';

export interface Blocker {
  kind: BlockerKind;
  detail: string;
  /**
   * `true` when a human at the keyboard can clear it in seconds (tick a
   * checkbox, solve an image grid, click a link in their inbox). `false` means
   * the run cannot proceed at all under this design.
   */
  humanCanClear: boolean;
  /**
   * `false` for walls the run raised itself ("could not fill these fields"),
   * which detectBlockers cannot see - so "not detected" never means "dealt
   * with", and only your click carries on.
   */
  autoClears?: boolean;
  /**
   * For a wall the run raised itself: how to tell, by looking at the page,
   * that you dealt with it anyway. Polled in place of detectBlockers.
   */
  clearedWhen?: () => Promise<boolean>;
  /**
   * CAPTCHA only: a challenge is showing now. Without it the captcha is merely
   * armed - invisible reCAPTCHA sits on every Greenhouse form and usually
   * passes on submit without anyone seeing it.
   */
  onScreen?: boolean;
}

/**
 * Detect the things that stop automated submission.
 *
 * This is the honest core of the system. A CAPTCHA is not a bug to be
 * engineered around - it is the site explicitly asking for a human, and both
 * Greenhouse and Lever ship one on their standard application forms
 * (reCAPTCHA and hCaptcha respectively). The design answer is to detect it,
 * stop, and hand the already-filled form to the person whose name is on it.
 * They spend five seconds instead of five minutes.
 *
 * Deliberately not implemented: solver services. They exist, they work, and
 * they are a straightforward violation of every one of these sites' terms.
 * Detection plus handoff keeps the whole flow defensible.
 */
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

export async function detectBlockers(page: Page): Promise<Blocker[]> {
  const found: Blocker[] = [];

  const captcha = await evaluatePage(page, () => {
    const hits: string[] = [];
    const q = (sel: string) => document.querySelector(sel);

    // Rendered widgets. An invisible reCAPTCHA also injects these, so their
    // presence alone is not proof a challenge will be shown - see `visible`.
    if (q('.g-recaptcha, #g-recaptcha, iframe[src*="recaptcha"]')) hits.push('recaptcha');
    if (q('.h-captcha, iframe[src*="hcaptcha"]')) hits.push('hcaptcha');
    if (q('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]')) hits.push('turnstile');
    if (q('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]')) hits.push('arkose');

    // Is a challenge actually on screen right now, versus armed but silent?
    const challengeVisible = Array.from(
      document.querySelectorAll<HTMLIFrameElement>(
        'iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com/captcha"], .cf-turnstile iframe',
      ),
    ).some((f) => {
      const r = f.getBoundingClientRect();
      return r.width > 40 && r.height > 40 && getComputedStyle(f).visibility !== 'hidden';
    });

    return { hits, challengeVisible };
  });

  if (captcha.hits.length) {
    found.push({
      kind: 'CAPTCHA',
      detail: captcha.challengeVisible
        ? `A ${captcha.hits.join('/')} challenge is on screen and must be solved by a person.`
        : `${captcha.hits.join('/')} is armed on this form. It may pass silently, or it may challenge on submit.`,
      humanCanClear: true,
      onScreen: captcha.challengeVisible,
    });
  }

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
        // SuccessFactors after Create Account: "We’ve sent a one-time password
        // to your email address" over a Passcode box.
        has(/we(['’]ve| have)? (just )?(sent|emailed) (you )?(a |an )?(one[- ]time (password|passcode)|passcode) to/),
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

/**
 * After clicking submit: did it land?
 *
 * Getting this wrong in either direction is expensive. A false "submitted"
 * means the candidate believes they applied when they did not. A false
 * "failed" produces duplicate applications. So we look for positive
 * confirmation and treat anything ambiguous as ambiguous.
 */
export async function detectSubmissionOutcome(
  page: Page,
  formUrlBefore: string,
  timeoutMs = 20_000,
): Promise<{ outcome: 'SUBMITTED' | 'VALIDATION_ERROR' | 'UNKNOWN'; detail: string }> {
  // One look is not enough. On a single-page app (Ashby, most modern
  // boards) the click does not navigate, so the page is already "loaded" and
  // networkidle resolves before the submit request has even left. Reading the
  // page then sees the form's last frame and calls it ambiguous. So keep
  // looking until the page says something decisive or the time runs out.
  const deadline = Date.now() + timeoutMs;
  const fromApplyStep = APPLE_APPLY.test(formUrlBefore);
  const decisive = (st: Awaited<ReturnType<typeof readOutcomeState>>) =>
    st.confirmed ||
    st.errors.length > 0 ||
    (st.url !== formUrlBefore && !st.hasForm) ||
    (fromApplyStep && st.appleProfile);
  let state = await readOutcomeState(page);
  while (!decisive(state) && Date.now() < deadline) {
    await page.waitForTimeout(750);
    state = await readOutcomeState(page);
  }
  // Let a navigation that is mid-flight finish before judging the url.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  state = await readOutcomeState(page);

  if (state.errors.length) {
    return { outcome: 'VALIDATION_ERROR', detail: state.errors.join(' | ') };
  }
  if (state.nativeInvalid.length && state.hasForm) {
    return {
      outcome: 'VALIDATION_ERROR',
      detail: `The browser blocked submission on required fields: ${state.nativeInvalid.join(' | ')}`,
    };
  }
  if (state.confirmed) {
    return { outcome: 'SUBMITTED', detail: state.snippet };
  }
  if (fromApplyStep && state.appleProfile) {
    return { outcome: 'SUBMITTED', detail: appleLandingDetail(state.url) };
  }
  // Navigated away from the form and nothing is left to fill: near-certainly
  // the confirmation page, just worded in a way we do not recognise.
  if (state.url !== formUrlBefore && !state.hasForm) {
    return { outcome: 'SUBMITTED', detail: `Navigated to ${state.url}. ${state.snippet}` };
  }
  // Said plainly: this is shown to a person deciding whether they applied.
  // The page text is noise to them; the url is on the job link already.
  return {
    outcome: 'UNKNOWN',
    detail: state.hasForm
      ? 'Submit was pressed but the form is still showing, so it probably did not go through. ' +
        'Usually a required field the site rejected, or a CAPTCHA.'
      : 'Submit was pressed but no confirmation message appeared.',
  };
}

/**
 * The site's own "thanks for applying" on screen right now, or null.
 *
 * Positive confirmation only: leaving the form is not counted here, because
 * someone browsing away from a tab they were left with also leaves the form.
 */
export async function confirmationShowing(page: Page): Promise<string | null> {
  const state = await readOutcomeState(page);
  return state.confirmed ? state.snippet : null;
}

/**
 * Apple Careers: Submit on Review & Submit leaves the application for your
 * profile, /app/<locale>/profile/info. Any toast there may be gone by the next
 * look, and the profile page has not been seen to say "submitted", so the move
 * is the confirmation. Only a move straight from Review & Submit counts. The
 * Profile link in Apple's header goes to the same page, so following it from
 * Review & Submit would be read as a submit too.
 */
const APPLE_APPLY = /^https:\/\/jobs\.apple\.com\/app\/[^/]+\/apply\//i;

function appleLandingDetail(url: string): string {
  return `Apple moved from Review & Submit to your profile (${url}), which it does once an application is submitted.`;
}

/**
 * For a tab watched while you act in it. `confirmed` is the site's own
 * confirmation; `appleStep` says whether this is Apple's Review & Submit step,
 * and `appleLanding` that this is Apple's profile page - a submit only when
 * the last step seen before it was Review & Submit.
 */
export async function submitWatchState(page: Page): Promise<{
  confirmed: string | null;
  appleStep: 'review' | 'between' | 'other';
  appleLanding: string | null;
}> {
  const state = await readOutcomeState(page);
  return {
    confirmed: state.confirmed ? state.snippet : null,
    appleStep: state.appleStep,
    appleLanding: state.appleProfile ? appleLandingDetail(state.url) : null,
  };
}

function readOutcomeState(page: Page) {
  return evaluatePage(page, () => {
    const text = document.body?.innerText ?? '';
    const lower = text.toLowerCase();

    /**
     * On screen, not merely in the document.
     *
     * A wizard that renders every screen up front and hides all but one keeps
     * the earlier screens' error messages and invalid fields mounted for the
     * rest of the session. Counting those reports a stale "Phone is required"
     * from step one as the reason a submission on step five failed - which is
     * both wrong and impossible to debug from the message.
     */
    const onScreen = (el: Element) =>
      typeof (el as HTMLElement).checkVisibility === 'function'
        ? (el as HTMLElement).checkVisibility()
        : (el as HTMLElement).offsetParent !== null;

    const errorNodes = Array.from(
      document.querySelectorAll('[aria-invalid="true"], .error:not(:empty), [role="alert"]:not(:empty), .field-error'),
    )
      .filter(onScreen)
      .map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 0 && t.length < 300);

    // Native constraint validation is the quiet failure mode: on a form
    // without `novalidate`, the browser blocks submission itself and the
    // submit event never fires. Nothing changes on screen, nothing is logged,
    // and the page looks exactly as it did. Reading .validity directly is the
    // only way to see it.
    const nativeInvalid = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'form input, form select, form textarea',
      ),
    )
      .filter((el) => typeof el.checkValidity === 'function' && !el.validity.valid)
      .filter(onScreen)
      .map((el) => {
        const name = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || 'field';
        return `${name}: ${el.validationMessage || 'invalid'}`;
      })
      .slice(0, 12);

    return {
      url: location.href,
      // Ashby and other SPAs mount their fields without a <form> wrapper, so
      // visible inputs anywhere count too.
      hasForm:
        !!document.querySelector('form input, form textarea') ||
        Array.from(
          document.querySelectorAll('input:not([type="hidden"]):not([type="search"]), textarea'),
        ).filter(onScreen).length >= 2,
      confirmed:
        /thank(s| you) for (applying|your application)/i.test(text) ||
        /your application (has been|was) (successfully )?(received|submitted|sent)/i.test(text) ||
        /(successfully|been) (submitted|received)/i.test(text) ||
        /application (received|submitted|complete)/i.test(lower) ||
        /we(’|')?ve received your application/i.test(text),
      errors: Array.from(new Set(errorNodes)).slice(0, 12),
      nativeInvalid,
      // 'between' is an Apple page with no wizard step on it: a frame mid-navigation.
      appleStep: document.querySelector('#apply-reviewAndSubmit-form')
        ? ('review' as const)
        : location.hostname === 'jobs.apple.com' && !document.querySelector('.apply-progress-steps')
          ? ('between' as const)
          : ('other' as const),
      appleProfile:
        location.hostname === 'jobs.apple.com' && /^\/app\/[^/]+\/profile\//i.test(location.pathname),
      snippet: text.replace(/\s+/g, ' ').slice(0, 400),
    };
  });
}
