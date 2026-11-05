import type { Page } from 'playwright';
import { evaluatePage } from './evaluate.js';

export interface OutcomeState {
  url: string;
  hasForm: boolean;
  confirmed: boolean;
  errors: string[];
  nativeInvalid: string[];
  appleStep: 'review' | 'between' | 'other';
  appleProfile: boolean;
  snippet: string;
}

export type SubmissionOutcome = 'SUBMITTED' | 'VALIDATION_ERROR' | 'UNKNOWN';

export interface SubmissionResult {
  outcome: SubmissionOutcome;
  detail: string;
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
 * Read the current state of the page to determine submission outcome.
 */
function readOutcomeState(page: Page): Promise<OutcomeState> {
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
        /we('|')?ve received your application/i.test(text),
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
): Promise<SubmissionResult> {
  // One look is not enough. On a single-page app (Ashby, most modern
  // boards) the click does not navigate, so the page is already "loaded" and
  // networkidle resolves before the submit request has even left. Reading the
  // page then sees the form's last frame and calls it ambiguous. So keep
  // looking until the page says something decisive or the time runs out.
  const deadline = Date.now() + timeoutMs;
  const fromApplyStep = APPLE_APPLY.test(formUrlBefore);
  const decisive = (st: OutcomeState) =>
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
