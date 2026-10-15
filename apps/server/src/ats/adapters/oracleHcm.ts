import type { Page } from 'playwright';
import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';

/**
 * Oracle Recruiting Cloud "Candidate Experience"
 * (<pod>.fa.<region>.oraclecloud.com/hcmUI/CandidateExperience/...).
 * American Express (egug.fa.us2, site CX_1) and JPMorgan Chase (jpmc.fa) use it.
 *
 * Checked live on Amex's posting 26015101 and against a JPMC apply page's HTML
 * in October 2026:
 *   - A posting is `.../sites/<site>/job/<id>`: `.job-details__title`,
 *     `.job-details__subtitle` (location), several
 *     `.job-details__description-content` blocks, and an "Apply Now" button.
 *     A cookie dialog (`.cookie-consent__button.decline`, "Reject All") covers
 *     it first; it is rejected, which keeps the site working.
 *   - "Apply Now" opens `.../job/<id>/apply/email`: Email Address, an
 *     "I agree with the terms and conditions" box and Next. A returning
 *     candidate is then asked for a code sent to that email (the wizard's
 *     email-verification handling). The page also carries a text input named
 *     `honey-pot` that reports itself visible; filling it marks the
 *     application as a bot, so it is dropped.
 *   - Then a "Welcome Back" dialog may offer the saved profile or an Indeed
 *     import; "Use My Profile" is taken.
 *   - The form is one page of sections shown one at a time ("page 1 of 4"),
 *     with Back / Next (`applyFlowPaginationNextButton`) and finally Submit in
 *     `.apply-flow-pagination`.
 *   - Section 1 starts with "Import your profile" (`.apply-flow-profile-import`),
 *     whose file input ("Import your profile from resume") feeds Oracle's
 *     parser, not the application. It is dropped, so the resume goes to the
 *     upload under `resume-upload-button`. That upload and the cover letter's
 *     (`cover-letter-upload-button`) are both named `attachment-upload`, so
 *     each is renamed after its wrapper here.
 *   - "Title" (and on some sites yes/no questions) are pill buttons
 *     (`ul[role=radiogroup] > li > button[role=radio][aria-checked]`).
 *     Amex's Application Questions (section 3, ~20 required yes/no) are
 *     instead 0x0 `input-row__hidden-control` radios, each under a drawn
 *     `label.apply-flow-input-radio[for]`, inside a `div[role=radiogroup]`
 *     named by its question label;
 *     dropdowns are `cx-select` comboboxes whose options are
 *     `[role=gridcell]` rows in `#<id>-listbox`; Preferred Location is a
 *     `cx-multi-select`. The shared extractor and filler handle all three.
 *   - The last section has an E-Signature "Full Name" box.
 *
 * The final step has not been seen in a real run, so every run stops for review.
 */

const DECLINE_COOKIES = '.cookie-consent__button.decline';
const APPLY_NOW = 'button.apply-now-button';
const PAGINATION = '.apply-flow-pagination';
const HONEYPOT = /honey-?pot/i;
const SETTLE_MS = 30_000;

async function dismissOverlays(page: Page): Promise<void> {
  const decline = page.locator(DECLINE_COOKIES).first();
  if (await decline.isVisible().catch(() => false)) await decline.click().catch(() => {});
  // "Welcome Back": keep the profile Oracle already has rather than importing from Indeed.
  const useProfile = page.getByRole('button', { name: /^use my profile$/i }).first();
  if (await useProfile.isVisible().catch(() => false)) await useProfile.click().catch(() => {});
}

/**
 * Wait for the spinner to go and a step (or the posting) to draw. Bounded:
 * a step that never settles is read anyway.
 */
async function settle(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const shown = (sel: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(sel)).some((el) => el.checkVisibility());
        if (shown('.apply-flow-checklist-dialog, [aria-busy="true"]')) return false;
        return (
          shown('.apply-flow-pagination button') ||
          shown('#primary-email-0, input[type="email"]') ||
          shown('.job-details__title') ||
          shown('input[id^="pin-code"], input[autocomplete="one-time-code"]')
        );
      },
      undefined,
      { timeout: SETTLE_MS, polling: 300 },
    )
    .catch(() => {});
  await dismissOverlays(page);
}

/** `.../job/<id>`, without any `/apply/...` tail, query or hash. */
function postingUrl(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/(\/job\/[^/]+)\/.*$/, '$1');
  return u.toString();
}

export const oracleHcmAdapter: AtsAdapter = {
  id: 'oracle-hcm',

  matches(url) {
    return /\.oraclecloud\.com\/hcmUI\/CandidateExperience\//i.test(url);
  },

  async openApplicationForm(page, url) {
    const posting = postingUrl(url);
    await page.goto(posting, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page);
    const apply = page.locator(APPLY_NOW).first();
    if (await apply.isVisible().catch(() => false)) {
      await apply.click();
    } else if (/\/job\/[^/]+$/.test(new URL(posting).pathname)) {
      await page.goto(`${posting}/apply/email`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    await page.waitForURL(/\/apply(\/|$)/, { timeout: 15_000 }).catch(() => {});
    await settle(page);
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const text = (sel: string) => clean(document.querySelector(sel)?.textContent);
      // "Software Engineer I - American Express Careers"
      const fromTitle = /\s[-|]\s(.+?)(?:\s+Careers?)?$/.exec(document.title)?.[1];
      return {
        title: text('.job-details__title') || clean(document.title.split(/\s[-|]\s/)[0]),
        company: clean(fromTitle) || location.hostname.split('.')[0] || 'Unknown',
        location: text('.job-details__subtitle') || undefined,
        // The apply pages do not carry the description; empty keeps the one
        // stored when the job was found.
        descriptionText: Array.from(document.querySelectorAll('.job-details__description-content'))
          .map((el) => clean((el as HTMLElement).innerText))
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 30000),
      };
    });
  },

  async settle(page) {
    await settle(page);
  },

  async afterWall(page) {
    await settle(page);
  },

  /**
   * The terms box on the email step is a 0x0 clipped input
   * (`input-row__hidden-control`) under a styled label, so the extractor never
   * sees it, and Next is refused until it is ticked. Required agreement boxes
   * of that kind are ticked; nothing else is touched. The click goes to the
   * drawn box (`.apply-flow-input-checkbox__button`): the label's centre is the
   * "terms and conditions" link, which opens the terms instead (checked live
   * on Amex, October 2026).
   */
  async beforeAdvance(page) {
    const boxes = page.locator('input[type="checkbox"].input-row__hidden-control[required]');
    for (let i = 0; i < (await boxes.count()); i++) {
      const box = boxes.nth(i);
      if (await box.isChecked().catch(() => true)) continue;
      const label = page.locator(`label[for="${await box.getAttribute('id')}"]`).first();
      const text = (await label.innerText().catch(() => '')).trim();
      if (!/\b(agree|accept|acknowledge|consent|certify)\b/i.test(text)) continue;
      await label.locator('.apply-flow-input-checkbox__button').first().click({ timeout: 3000 }).catch(() => {});
      if (!(await box.isChecked().catch(() => false))) await box.check({ force: true }).catch(() => {});
    }
  },

  async extractForm(page) {
    const fields = await extractFields(page, { harvestComboboxOptions: true });
    // Where each control sits: the profile-import box, or one of the two
    // identically named attachment uploads.
    const places = await page.evaluate(
      (selectors) =>
        selectors.map((sel) => {
          const el = document.querySelector(sel);
          if (!el) return '';
          if (el.closest('.apply-flow-profile-import')) return 'import';
          if (el.closest('resume-upload-button')) return 'resume';
          if (el.closest('cover-letter-upload-button')) return 'cover_letter';
          return '';
        }),
      fields.map((f) => f.selector),
    );
    return fields
      .map((f, i) => (places[i] === 'resume' || places[i] === 'cover_letter' ? { ...f, name: places[i] } : f))
      .filter((f, i) => places[i] !== 'import' && !HONEYPOT.test(`${f.name ?? ''} ${f.label}`));
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    const cover = files.find((f) => /cover/i.test(fileHint(f)));
    return {
      resume: files.find((f) => f !== cover && /resume|cv/i.test(fileHint(f))) ?? files.find((f) => f !== cover),
      coverLetter: cover,
    };
  },

  async submit(page) {
    await settle(page);
    const button = page
      .locator(`${PAGINATION} button`)
      .filter({ hasText: /^\s*submit\s*$/i })
      .first();
    if (!(await button.isVisible().catch(() => false))) {
      throw new Error("Not on Oracle's last section: there is no Submit button in the pagination bar.");
    }
    await button.click();
  },

  alwaysReview: true,

  notes: [
    'Starts from the posting: rejects non-essential cookies, then "Apply Now".',
    'The first step is your email and the terms box; a returning candidate gets an emailed code, read from your inbox when a Gmail app password is saved.',
    'Ticks Oracle\'s required "I agree with the terms and conditions" box, which is hidden from the form reader.',
    'Takes "Use My Profile" when Oracle offers your saved profile.',
    'The resume goes to the application\'s own upload, not Oracle\'s "Import your profile" parser.',
    'The final step has not been mapped yet, so every run stops for review.',
  ],
};
