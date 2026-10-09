import type { Page } from 'playwright';
import type { BlockerKind } from '@ja/shared';
import { detectBlockers } from './blockers.js';
import { detectAutofillPrompt, isNavigationRace, settle } from './steps.js';

/**
 * Getting from a job URL to a form you can actually fill.
 *
 * The naive shape - navigate, wait for `<form>`, fill - is wrong on most
 * modern boards, in three separate ways:
 *
 *  1. **There is often an interstitial first.** Cloudflare and similar bot
 *     checks render *instead of* the page. Waiting for a form during one is
 *     waiting for something that does not exist yet.
 *
 *  2. **The form is usually behind an Apply button.** The job URL shows a
 *     description; the application only mounts after a click. Ashby, Workable
 *     and most careers pages work this way.
 *
 *  3. **`<form>` is the wrong thing to wait for.** Ashby's application is
 *     React-rendered inputs with no `<form>` wrapper at all. What matters is
 *     whether there are fillable controls on screen, not whether a particular
 *     tag exists.
 *
 * So: clear the interstitial, click through to the application, then wait for
 * *inputs*. Each step reports what it actually saw, because "waiting for
 * locator('form') to be visible" tells you nothing about which of the three
 * went wrong.
 */

/** Thrown when only a person can get past what is on screen. */
export class NeedsHumanError extends Error {
  constructor(
    message: string,
    // The full blocker vocabulary, not a subset: an account wall and an
    // emailed verification code are different problems from a captcha, and
    // flattening them into LOGIN_REQUIRED would make the run tell the person
    // to do the wrong thing.
    readonly kind: BlockerKind,
  ) {
    super(message);
    this.name = 'NeedsHumanError';
  }
}

/** Thrown when the page loaded fine but no application form could be reached. */
export class NoFormError extends Error {
  constructor(
    message: string,
    readonly diagnosis: FormDiagnosis,
  ) {
    super(message);
    this.name = 'NoFormError';
  }
}

export interface FormDiagnosis {
  url: string;
  title: string;
  inputCount: number;
  hasFormTag: boolean;
  applyControls: string[];
  interstitial: string | null;
  bodyStart: string;
}

/**
 * Are there controls a person could type into?
 *
 * Deliberately counts controls rather than looking for a `<form>`: that is the
 * thing every caller actually cares about, and it is true on Ashby's
 * form-less markup as well as on Lever's classic form.
 */
export async function countFillableInputs(page: Page): Promise<number> {
  return page.evaluate(() => {
    // Into open shadow roots too: SmartRecruiters' form has no light-DOM
    // inputs at all, every one sits inside an `spl-*` web component.
    const controls: HTMLElement[] = [];
    const visit = (node: ParentNode) => {
      for (const el of Array.from(node.children)) {
        if (el.matches('input, textarea, select, [role="combobox"], [contenteditable="true"]')) {
          controls.push(el as HTMLElement);
        }
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(document);
    return controls.filter((el) => {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return false;
      // Captcha response fields are inputs but are not ours to fill, and a page
      // showing only those is a challenge page, not an application form.
      const id = `${el.getAttribute('name') ?? ''} ${el.id}`;
      if (/recaptcha|captcha|turnstile/i.test(id)) return false;
      // A file input is routinely 0x0 behind a styled button, so a box check
      // would reject a perfectly good one. But it must still be in the
      // rendered tree: one sitting inside a display:none application region is
      // not reachable, and counting it makes an unmounted form look ready.
      if (type === 'file') {
        return typeof el.checkVisibility === 'function'
          ? el.checkVisibility()
          : el.offsetParent !== null;
      }
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;
  });
}

/**
 * Whether a resume/CV upload is reachable on screen right now.
 *
 * Used to decide whether "there are fillable inputs already" can be trusted
 * as "this is the application". It usually can be - but a company careers
 * page can carry something else on the same screen that also asks for a name
 * and an email: a "join our talent community" widget, a job-alert sign-up.
 * Those essentially never ask for a resume; a job application almost always
 * does, even when the field is optional. A live run against a Roku posting
 * filled exactly such a sidebar widget under the candidate's name, because
 * three text inputs were enough to satisfy `minInputs` before the real
 * application - already in the page, just hidden until Apply is clicked -
 * was ever revealed.
 */
async function hasVisibleFileInput(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const files: HTMLInputElement[] = [];
    const visit = (node: ParentNode) => {
      for (const el of Array.from(node.children)) {
        if (el.matches('input[type=file]')) files.push(el as HTMLInputElement);
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(document);
    return files.some((el) =>
      typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null,
    );
  });
}

/**
 * Is a bot-check interstitial on screen right now?
 *
 * Returns the name of the challenge, or null. Distinct from
 * `detectBlockers` in blockers.ts: that reports a captcha *armed on a form*,
 * which is normal and not blocking. This is the case where the challenge has
 * replaced the page.
 */
export async function detectInterstitial(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    // Count only what is actually ON SCREEN. A page can carry a whole
    // application in hidden markup behind the challenge, and counting those
    // would mask the interstitial entirely - which is precisely how the
    // detector missed a stuck Cloudflare page the first time.
    const inputCount = Array.from(
      document.querySelectorAll<HTMLElement>('input:not([type=hidden]), textarea, select'),
    ).filter((el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;

    // Cloudflare's managed challenge: its own page, minimal content.
    if (
      /just a moment|checking your browser|verify you are human|verifying you are human/i.test(text) &&
      inputCount < 3
    ) {
      return 'cloudflare';
    }
    if (document.querySelector('#challenge-running, #cf-challenge-running, .cf-browser-verification')) {
      return 'cloudflare';
    }
    // A standalone Turnstile widget with nothing else on the page.
    if (document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]') && inputCount < 3) {
      return 'turnstile';
    }
    if (/attention required|access denied|unusual traffic|request blocked/i.test(text) && inputCount < 3) {
      return 'blocked';
    }
    return null;
  });
}

/**
 * Wait out an interstitial.
 *
 * Most managed challenges resolve themselves in a few seconds when the browser
 * looks legitimate, which a warmed-up persistent profile usually does. If it
 * has not cleared inside the budget, a person has to click it - so throw
 * rather than pressing on into a page that was never rendered.
 */
export async function clearInterstitial(page: Page, budgetMs = 25_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let seen: string | null = null;

  while (Date.now() < deadline) {
    // A page still redirecting (forms.gle -> docs.google.com) destroys the
    // context mid-read. That is "not arrived yet", not a failure.
    let now: string | null;
    try {
      now = await detectInterstitial(page);
    } catch (err) {
      if (!isNavigationRace(err)) throw err;
      await settle(page);
      continue;
    }
    if (!now) return;
    seen = now;
    await page.waitForTimeout(1000);
  }

  if (seen) {
    throw new NeedsHumanError(
      seen === 'blocked'
        ? 'The site served a bot-detection block instead of the job page. Open the browser window and check whether it lets you through by hand.'
        : `A ${seen} challenge is still on screen after ${Math.round(budgetMs / 1000)}s and has replaced the job page. ` +
          'Solve it in the open browser window, then restart this application - the profile keeps the clearance cookie so the next run should sail through.',
      'CAPTCHA',
    );
  }
}

/**
 * "Apply Manually" starts with "apply" but is not the job's Apply button: it is
 * one side of the autofill choice the wizard makes (it prefers the resume).
 */
const NOT_THE_APPLY_BUTTON = /manually|autofill|auto-fill|use my last application/i;

/** Labels that open an application, in rough order of specificity. */
const APPLY_PATTERNS = [
  /apply for this job/i,
  /apply now/i,
  /submit (an )?application/i,
  /start (your )?application/i,
  /^apply$/i,
  /^apply\b/i,
  // SmartRecruiters, including postings embedded on a company's own domain.
  /^i[’']?m interested$/i,
];

/**
 * Navigate to a job URL and end up on something fillable.
 *
 * Order matters and each step is separately reported, so a failure says which
 * stage broke instead of "locator('form') was not visible".
 */
export async function openApplicationForm(
  page: Page,
  url: string,
  opts: {
    /** Extra selectors that mean "the form is here", checked alongside the input count. */
    formSelectors?: string[];
    /** Minimum inputs before we call it a form. Two avoids matching a search box. */
    minInputs?: number;
    /** Extra apply-control patterns for a specific board. */
    applyPatterns?: RegExp[];
  } = {},
): Promise<void> {
  const minInputs = opts.minInputs ?? 2;
  const patterns = [...(opts.applyPatterns ?? []), ...APPLY_PATTERNS];

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  // A URL that redirects by script after load would otherwise be read
  // half-way, and every page.evaluate below would die with it.
  await settle(page);

  // 1. Interstitial, if any. Nothing else can be true until this is gone.
  await clearInterstitial(page);

  // React boards need a beat after DOMContentLoaded before anything mounts.
  await page.waitForTimeout(700);

  // 2. Already on the form? Some URLs point straight at it (Lever's /apply).
  //
  // Trusted outright when an adapter passed its own formSelectors - it knows
  // its DOM precisely. The generic fallback does not, and a bare input count
  // cannot tell a real application from something else on the same page that
  // also asks for a name and an email - see hasVisibleFileInput. So the
  // generic path additionally wants resume evidence before it will accept
  // "the form is already here" and skip the Apply click; failing that it
  // falls through to step 3 exactly as if nothing had been found yet.
  if (await formReady(page, minInputs, opts.formSelectors)) {
    if (opts.formSelectors?.length || (await hasVisibleFileInput(page))) return;
  }

  // 3. Otherwise click through. Two attempts: the first click sometimes lands
  //    before hydration finishes and does nothing at all.
  for (let attempt = 0; attempt < 2; attempt++) {
    const clicked = await clickApply(page, patterns);
    if (!clicked && attempt === 0) {
      // No control found yet - it may still be rendering.
      await page.waitForTimeout(1500);
      continue;
    }

    if (clicked) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // An Apply link can navigate to a fresh page with its own challenge.
      await clearInterstitial(page).catch((err: unknown) => {
        throw err;
      });
      // Workday's Apply opens "Autofill with Resume / Apply Manually". That is
      // the start of the application, and the wizard decides it - clicking
      // Apply again here picked "Apply Manually" every time.
      if (await detectAutofillPrompt(page)) return;
      if (await formReady(page, minInputs, opts.formSelectors, 15_000)) return;
    }
  }

  // 4. One last look, in case it mounted late.
  if (await formReady(page, minInputs, opts.formSelectors, 8000)) return;

  // 5. Before declaring there is no form: is there a wall in front of it?
  //
  // Clicking Apply very often lands on a sign-in rather than on the
  // application - Google Careers redirects to accounts.google.com, and every
  // account-based ATS does the equivalent. Reporting that as "could not reach
  // an application form" is technically true and completely unhelpful: it
  // names neither the cause nor the one thing the person can do about it. It
  // is also the difference between a run that ends and a run that pauses,
  // because a wall is resumable and a missing form is not.
  const wall = (await detectBlockers(page)).find(
    (b) =>
      b.humanCanClear &&
      (b.kind === 'LOGIN_REQUIRED' ||
        b.kind === 'ACCOUNT_CREATION' ||
        b.kind === 'EMAIL_VERIFICATION' ||
        b.kind === 'CAPTCHA'),
  );
  if (wall) throw new NeedsHumanError(wall.detail, wall.kind);

  throw new NoFormError(
    'Could not reach an application form on this page.',
    await diagnose(page, patterns),
  );
}

async function formReady(
  page: Page,
  minInputs: number,
  formSelectors: string[] | undefined,
  timeoutMs = 4000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (formSelectors?.length) {
      for (const sel of formSelectors) {
        if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
      }
    }
    // Apply links that bounce through a sign-in (Google Careers) navigate
    // twice; a read landing between them is no answer, not a failure.
    const inputs = await countFillableInputs(page).catch((err: unknown) => {
      if (isNavigationRace(err)) return 0;
      throw err;
    });
    if (inputs >= minInputs) return true;
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return false;
}

/**
 * Find and click whatever opens the application.
 *
 * Returns whether a click actually landed. The old code swallowed click
 * failures with `.catch(() => {})` and then waited on a form that could never
 * appear, which is exactly how you get a twenty-second timeout with no clue
 * why.
 */
async function clickApply(page: Page, patterns: RegExp[]): Promise<boolean> {
  for (const pattern of patterns) {
    for (const role of ['button', 'link'] as const) {
      const control = page.getByRole(role, { name: pattern });
      const count = await control.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 3); i++) {
        const nth = control.nth(i);
        if (!(await nth.isVisible().catch(() => false))) continue;
        const name = (await nth.innerText().catch(() => '')) || (await nth.getAttribute('aria-label').catch(() => '')) || '';
        if (NOT_THE_APPLY_BUTTON.test(name)) continue;
        // Apply buttons that open the form in a new tab (target=_blank, or
        // window.open) leave this page exactly where it was, and every later
        // step reads this page. Catch the tab and bring its address here.
        const opened: Page[] = [];
        const onPage = (p: Page) => opened.push(p);
        page.context().on('page', onPage);
        try {
          await nth.scrollIntoViewIfNeeded({ timeout: 3000 });
          await nth.click({ timeout: 8000 });
          await page.waitForTimeout(900);
          page.context().off('page', onPage);
          if (opened[0]) await followNewTab(page, opened[0]);
          return true;
        } catch {
          page.context().off('page', onPage);
          // Overlays and cookie banners intercept the first click; try the
          // next candidate rather than giving up on the whole page.
        }
      }
    }
  }
  return false;
}

/**
 * Load what a new tab opened onto `page`, and close the tab.
 *
 * The tab starts on about:blank and may pass through a redirect, so wait for
 * a real address first. If it never gets one, leave `page` alone.
 */
async function followNewTab(page: Page, tab: Page): Promise<void> {
  try {
    await tab
      .waitForURL((u) => /^https?:$/.test(u.protocol), { timeout: 15_000, waitUntil: 'commit' })
      .catch(() => {});
    // A short link (forms.gle) redirects again; read where it ends up.
    await settle(tab);
    const url = tab.url();
    if (!/^https?:/.test(url)) return;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } finally {
    await tab.close().catch(() => {});
  }
}

/** Everything worth knowing about why there was no form. */
async function diagnose(page: Page, patterns: RegExp[]): Promise<FormDiagnosis> {
  const applyControls: string[] = [];
  for (const pattern of patterns) {
    for (const role of ['button', 'link'] as const) {
      const control = page.getByRole(role, { name: pattern });
      const count = await control.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 3); i++) {
        const text = (await control.nth(i).innerText().catch(() => '')).trim();
        const visible = await control.nth(i).isVisible().catch(() => false);
        if (text) applyControls.push(`${role}:"${text}"${visible ? '' : ' (hidden)'}`);
      }
    }
  }

  const page_ = await page.evaluate(() => ({
    title: document.title,
    hasFormTag: !!document.querySelector('form'),
    bodyStart: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
  }));

  return {
    url: page.url(),
    title: page_.title,
    hasFormTag: page_.hasFormTag,
    inputCount: await countFillableInputs(page),
    applyControls: [...new Set(applyControls)],
    interstitial: await detectInterstitial(page),
    bodyStart: page_.bodyStart,
  };
}

/** Turn a diagnosis into something worth putting in a run log. */
export function describeDiagnosis(d: FormDiagnosis): string {
  const bits = [
    `at ${d.url}`,
    `${d.inputCount} fillable input(s)`,
    d.hasFormTag ? 'a <form> tag is present' : 'no <form> tag',
    d.applyControls.length
      ? `apply controls seen: ${d.applyControls.join(', ')}`
      : 'no apply button or link found',
  ];
  if (d.interstitial) bits.push(`an ${d.interstitial} interstitial is still showing`);
  return `${bits.join('; ')}. Page begins: "${d.bodyStart}"`;
}
