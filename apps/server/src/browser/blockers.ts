import type { Page } from 'playwright';
import type { BlockerKind } from '@ja/shared';

export interface Blocker {
  kind: BlockerKind;
  detail: string;
  /**
   * `true` when a human at the keyboard can clear it in seconds (tick a
   * checkbox, solve an image grid, click a link in their inbox). `false` means
   * the run cannot proceed at all under this design.
   */
  humanCanClear: boolean;
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
export async function detectBlockers(page: Page): Promise<Blocker[]> {
  const found: Blocker[] = [];

  const captcha = await page.evaluate(() => {
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
    });
  }

  const signals = await page.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() ?? '';
    const has = (re: RegExp) => re.test(text);
    return {
      login:
        !!document.querySelector('input[type="password"]') ||
        has(/sign in to (continue|apply)/) ||
        has(/log ?in to your account/),
      createAccount:
        has(/create (an )?account to apply/) ||
        has(/register to (continue|apply)/) ||
        (!!document.querySelector('input[type="password"]') && has(/confirm password/)),
      emailVerification:
        has(/verify your email/) ||
        has(/we sent (you )?a (verification )?(code|link)/) ||
        has(/enter the (6|four|six)[- ]digit code/),
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
  if (signals.createAccount) {
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
): Promise<{ outcome: 'SUBMITTED' | 'VALIDATION_ERROR' | 'UNKNOWN'; detail: string }> {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

  const state = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const lower = text.toLowerCase();
    const errorNodes = Array.from(
      document.querySelectorAll('[aria-invalid="true"], .error:not(:empty), [role="alert"]:not(:empty), .field-error'),
    )
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
      .map((el) => {
        const name = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || 'field';
        return `${name}: ${el.validationMessage || 'invalid'}`;
      })
      .slice(0, 12);

    return {
      url: location.href,
      hasForm: !!document.querySelector('form input, form textarea'),
      confirmed:
        /thank you for (applying|your application)/i.test(text) ||
        /your application (has been|was) (received|submitted)/i.test(text) ||
        /application (received|submitted|complete)/i.test(lower) ||
        /we(’|')?ve received your application/i.test(text),
      errors: Array.from(new Set(errorNodes)).slice(0, 12),
      nativeInvalid,
      snippet: text.replace(/\s+/g, ' ').slice(0, 400),
    };
  });

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
  // Navigated away from the form and nothing is left to fill: near-certainly
  // the confirmation page, just worded in a way we do not recognise.
  if (state.url !== formUrlBefore && !state.hasForm) {
    return { outcome: 'SUBMITTED', detail: `Navigated to ${state.url}. ${state.snippet}` };
  }
  return {
    outcome: 'UNKNOWN',
    detail: `Could not confirm. Still at ${state.url}. Page says: ${state.snippet}`,
  };
}
