import type { Page } from 'playwright';
import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';

/**
 * Workday (<tenant>.wd<N>.myworkdayjobs.com, myworkdaysite.com).
 *
 * Checked against a live CrowdStrike posting and saved run snapshots in
 * October 2026:
 *   - `<posting>/apply` opens the start page directly: "Autofill with Resume",
 *     "Apply Manually", "Use My Last Application". The wizard's autofill
 *     handling takes the first.
 *   - Every step after that is behind a Workday account. The account-wall
 *     handling signs in with the saved email and password.
 *   - The wizard is ~6 steps (Autofill with Resume, My Information, My
 *     Experience, Application Questions, Voluntary Disclosures, Review), each
 *     a client-side render under `applyFlowPage`, with one footer button
 *     `pageFooterNextButton` that says "Save and Continue" and then "Submit".
 *   - That button is disabled while a step loads, saves, or uploads a file.
 *     Reading a step in that window found no controls and no enabled button,
 *     which the wizard took for "single page form, submit it". `settle` waits
 *     it out - and for the step's own controls, because the `applyFlowPage`
 *     container is drawn before them (a Create Account screen read in that
 *     gap looked like an empty step 1 and ended the run).
 *   - A cookie notice (`legalNotice`) sits over the page until answered. It is
 *     declined: only the necessary cookies, which the site works with.
 *   - Two dropdowns that are not selects. "How Did You Hear About Us?" and
 *     "Country Phone Code" are search prompts (a text input with
 *     `data-uxi-widget-type="selectinput"`, filled as `workday-prompt`);
 *     "Phone Device Type" is a `button[aria-haspopup="listbox"]`
 *     (`workday-dropdown`). Typed into as text boxes, they stayed at
 *     "0 items selected" and Workday refused the step.
 *   - Signing in can drop you on Candidate Home ("My Applications") or the
 *     bare posting instead of the step you were on (BlackRock and Walmart in
 *     October 2026: the run read Candidate Home as a step and went nowhere).
 *     `afterWall` goes back to `<posting>/apply`, which resumes the draft.
 */

const NEXT = '[data-automation-id="pageFooterNextButton"]';
const DECLINE_COOKIES = '[data-automation-id="legalNoticeDeclineButton"]';
const SETTLE_MS = 30_000;

/**
 * `<posting>/apply` and its steps: "apply" after the `/job/` part. A bare
 * `/apply/` is not enough, because eBay's career site is itself named "apply"
 * (`ebay.wd5.myworkdayjobs.com/apply/job/...`, October 2026): its postings
 * passed for the start page, so the run never went past the posting.
 */
const APPLY_PATH = /\/job\/.+\/apply(\/|$)/;

async function declineCookies(page: Page): Promise<void> {
  const decline = page.locator(DECLINE_COOKIES).first();
  if (await decline.isVisible().catch(() => false)) await decline.click().catch(() => {});
}

/** Reloads tried on Workday's "Something went wrong" screen before giving up. */
const ERROR_RELOADS = 2;

/**
 * Workday's own error screen: an `<h1>` "Something went wrong" and "Please
 * refresh the page and then try again." in place of the step (Expedia,
 * October 2026). The step underneath is fine; a reload brings it back.
 */
function errorScreenShown(): boolean {
  const heading = Array.from(document.querySelectorAll('h1'));
  return heading.some(
    (h) => (h as HTMLElement).checkVisibility() && /^something went wrong\b/i.test((h.textContent ?? '').trim()),
  ) && /refresh the page/i.test(document.body?.innerText ?? '');
}

/**
 * Wait until the step has drawn and is not busy.
 *
 * Bounded: when the step never settles the wizard reads it anyway, and
 * reports what it finds, rather than hanging the run.
 */
async function settle(page: Page): Promise<void> {
  for (let reloads = 0; ; reloads++) {
    await settleOnce(page);
    if (reloads >= ERROR_RELOADS) return;
    if (!(await page.evaluate(errorScreenShown).catch(() => false))) return;
    // Read as a step, the error screen has no controls and no button, and the
    // run ended there as a form with nothing on it.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
  }
}

async function settleOnce(page: Page): Promise<void> {
  await declineCookies(page);
  await page
    .waitForFunction(
      (next) => {
        const shown = (el: Element | null) => !!el && (el as HTMLElement).checkVisibility();
        // Workday's error screen (see errorScreenShown): nothing more will
        // draw, so stop waiting and let `settle` reload.
        const failed = Array.from(document.querySelectorAll('h1')).some(
          (h) => shown(h) && /^something went wrong\b/i.test((h.textContent ?? '').trim()),
        );
        if (failed) return true;
        const button = document.querySelector<HTMLButtonElement>(next);
        // Saving, loading or uploading.
        if (button?.disabled) return false;
        // The outer apply container appears before the step inside it, so
        // its presence proves nothing. Wait for something to act on: a
        // control (an upload counts by its drop zone; the robots-only
        // honeypot does not count), the start page's choices, or the
        // footer button on a step with no controls (Review).
        const control = Array.from(
          document.querySelectorAll<HTMLElement>(
            'input:not([type="hidden"]):not([data-automation-id="beecatcher"]), select, textarea, [role="combobox"], button[aria-haspopup="listbox"]',
          ),
        )
          // The header's language picker is on every page.
          .filter((el) => !el.closest('[data-automation-id="header"]'))
          .some((el) =>
            (el as HTMLInputElement).type === 'file' ? shown(el) || shown(el.parentElement) : shown(el),
          );
        const startPage = shown(document.querySelector('[data-automation-id="autofillWithResume"], [data-automation-id="applyManually"]'));
        return control || startPage || shown(button);
      },
      NEXT,
      { timeout: SETTLE_MS, polling: 250 },
    )
    .catch(() => {});
  await declineCookies(page);
}

/** On the start page or a step of the apply wizard, not elsewhere on the site. */
async function inApplyFlow(page: Page): Promise<boolean> {
  return page
    .evaluate((applyPath) => {
      const shown = (sel: string) => !!(document.querySelector(sel) as HTMLElement | null)?.checkVisibility();
      if (shown('[data-automation-id="CandidateHomePage"]')) return false;
      return (
        new RegExp(applyPath).test(location.pathname) ||
        shown('[data-automation-id="applyFlowPage"]') ||
        shown('[data-automation-id="autofillWithResume"], [data-automation-id="applyManually"]')
      );
    }, APPLY_PATH.source)
    .catch(() => false);
}

/** `<posting>/apply`, the start page, without going through the posting. */
function applyUrl(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  if (/\/job\//.test(u.pathname) && !APPLY_PATH.test(u.pathname)) {
    u.pathname = `${u.pathname.replace(/\/$/, '')}/apply`;
  }
  return u.toString();
}

export const workdayAdapter: AtsAdapter = {
  id: 'workday',

  matches(url) {
    return /\.myworkdayjobs\.com|\.myworkdaysite\.com/i.test(url);
  },

  async openApplicationForm(page, url) {
    await page.goto(applyUrl(url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page);
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const text = (sel: string) => clean(document.querySelector(sel)?.textContent);
      return {
        title:
          text('[data-automation-id="jobPostingHeader"]') ||
          text('[data-automation-id="jobTitleHeading"]') ||
          clean(document.title),
        company: location.hostname.split('.')[0] ?? 'Unknown',
        location: text('[data-automation-id="locations"]') || undefined,
        // The apply pages do not carry the description; empty keeps the one
        // stored when the job was found.
        descriptionText: text('[data-automation-id="jobPostingDescription"]').slice(0, 30000),
      };
    });
  },

  async settle(page) {
    await settle(page);
  },

  async afterWall(page, url) {
    await settle(page);
    if (await inApplyFlow(page)) return;
    await page.goto(applyUrl(url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page);
  },

  async extractForm(page) {
    return extractFields(page, { harvestComboboxOptions: true });
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    return {
      resume: files.find((f) => /resume|cv/i.test(fileHint(f))) ?? files[0],
      coverLetter: files.find((f) => /cover/i.test(fileHint(f))),
    };
  },

  async submit(page) {
    await settle(page);
    const button = page.locator(NEXT).first();
    const label = ((await button.textContent().catch(() => '')) ?? '').trim();
    if (!/submit/i.test(label)) {
      throw new Error(
        `Not on Workday's Review step: the footer button says "${label || 'nothing'}", not Submit.`,
      );
    }
    await button.click();
  },

  alwaysReview: true,

  notes: [
    'Needs a Workday account per company; the saved email and password are used to sign in.',
    'Takes "Autofill with Resume", so Workday parses your resume into the experience step.',
    'Cookie notice is declined (necessary cookies only).',
    'Search-prompt dropdowns ("How did you hear about us?") are searched and picked, not typed into.',
    'After signing in, goes back to the application if Workday lands on Candidate Home.',
  ],
};
