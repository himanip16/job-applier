import type { Page } from 'playwright';
import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { NeedsHumanError } from '../../browser/openForm.js';
import { PostingGoneError } from '../../engine/deadPosting.js';
import { hasLinkedInSession, LinkedInSignInRequired, openLinkedIn } from '../../linkedin/session.js';
import { isLinkedInJob } from '../../linkedin/jobs.js';

/**
 * LinkedIn Easy Apply (www.linkedin.com/jobs/view/<id>).
 *
 * Only Easy Apply postings reach this adapter: the runner first asks
 * resolveApplyUrl where Apply goes, and a posting that hands off to the
 * company's own Greenhouse or Workday form is driven there instead.
 *
 * Easy Apply is a wizard in a modal over the posting, on your own signed-in
 * LinkedIn session (the shared Chromium profile; nothing here signs in):
 *   - Contact info (email select, phone country code, mobile number), then
 *     Resume (saved resumes as cards, and a hidden "Upload resume" file input),
 *     then zero or more pages of the employer's questions, then Review.
 *   - The buttons are labelled by aria-label: "Continue to next step",
 *     "Review your application", "Submit application".
 *   - Review carries a pre-ticked "Follow <company>" box.
 *   - The modal sits over the whole posting page, whose search box, buttons
 *     and carousels are still visible to the DOM behind the overlay. The
 *     engine's field and Next lookups read the whole document, so `settle`
 *     hides everything that is not the modal. A person looking at a paused run
 *     sees the modal on a blank page; that is this, not a broken page.
 *
 * Written from LinkedIn's known markup, not from a run of this app: the
 * selectors are lists of alternatives, and the final step always goes through
 * review until a real submit has been seen.
 */

/** The Easy Apply dialog, by class (classic layout) or by what it says (newer ones). */
function findModal(): Element | null {
  const known = document.querySelector('.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"]');
  if (known) return known;
  return (
    Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (d) =>
        /easy apply|apply to\b/i.test(d.textContent ?? '') &&
        !!d.querySelector('input, select, textarea, button[aria-label*="next step" i], button[aria-label*="submit application" i]'),
    ) ?? null
  );
}

const MODAL_SELECTOR =
  '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [role="dialog"]:has(button[aria-label*="next step" i]), ' +
  '[role="dialog"]:has(button[aria-label*="review your application" i]), [role="dialog"]:has(button[aria-label*="submit application" i])';

const EASY_APPLY_BUTTON =
  'button.jobs-apply-button:visible, button[aria-label*="Easy Apply" i]:visible, a[aria-label*="Easy Apply" i]:visible, ' +
  'a[href*="openSDUIApplyFlow"]:visible';

const SIGN_IN =
  'Easy Apply needs you signed in to LinkedIn. The app never handles your password: sign in to ' +
  'linkedin.com yourself in the browser window it controls, then carry on.';

/** Hide everything on the page that is not the Easy Apply modal. */
async function isolateModal(page: Page): Promise<boolean> {
  return page
    .evaluate(`(() => {
      const findModal = ${findModal.toString()};
      const modal = findModal();
      if (!modal) return false;
      if (!document.getElementById('ja-behind-modal')) {
        const style = document.createElement('style');
        style.id = 'ja-behind-modal';
        style.textContent = '[data-ja-behind-modal] { display: none !important; }';
        document.head.appendChild(style);
      }
      // Every sibling of the modal and of each of its ancestors: whatever
      // wraps the modal, only the path down to it stays drawn.
      for (let node = modal; node && node !== document.body; node = node.parentElement) {
        const parent = node.parentElement;
        if (!parent) break;
        for (const sib of Array.from(parent.children)) {
          if (sib === node || /^(SCRIPT|STYLE|LINK)$/.test(sib.tagName)) continue;
          sib.setAttribute('data-ja-behind-modal', '');
        }
      }
      return true;
    })()`)
    .then(Boolean)
    .catch(() => false);
}

export const linkedinAdapter: AtsAdapter = {
  id: 'linkedin',

  matches(url) {
    return isLinkedInJob(url);
  },

  async openApplicationForm(page, url) {
    if (!(await hasLinkedInSession())) throw new NeedsHumanError(SIGN_IN, 'LOGIN_REQUIRED');
    try {
      await openLinkedIn(page, url);
    } catch (err) {
      if (err instanceof LinkedInSignInRequired) throw new NeedsHumanError(err.message, 'LOGIN_REQUIRED');
      throw err;
    }

    // Opened by hand during a pause, or left open by an earlier attempt.
    if (await page.locator(MODAL_SELECTOR).first().isVisible().catch(() => false)) {
      await isolateModal(page);
      return;
    }

    const button = page.locator(EASY_APPLY_BUTTON).first();
    await button.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    if (!(await button.count().catch(() => 0))) {
      const text = await page
        .evaluate(() => (document.body.innerText ?? '').slice(0, 20000))
        .catch(() => '');
      if (/no longer accepting applications|this job is no longer available|applications are closed/i.test(text)) {
        throw new PostingGoneError('LinkedIn says this posting is no longer accepting applications.');
      }
      if (/\bapplied \d+ \w+ ago\b|application submitted|see application/i.test(text)) {
        throw new Error('LinkedIn shows you have already applied to this job.');
      }
      if (/apply on company website/i.test(text)) {
        throw new Error(
          "This posting's Apply goes to the company's own site, not Easy Apply, and the hand-off " +
            'could not be followed. Run it again; if it keeps happening, apply from the company site.',
        );
      }
      throw new NeedsHumanError(
        'No Easy Apply button on this LinkedIn posting. If LinkedIn is showing a sign-in or a ' +
          'check in the browser window, clear it there and carry on.',
        'UNKNOWN',
      );
    }

    await button.click({ timeout: 8000 });
    // The newer layout goes to /jobs/view/<id>/apply/ first; the modal draws after.
    await page
      .locator(MODAL_SELECTOR)
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => {
        throw new NeedsHumanError(
          'Pressed Easy Apply but its form did not open. Open it in the browser window, then carry on.',
          'UNKNOWN',
        );
      });
    await isolateModal(page);
  },

  async readJobMeta(page): Promise<JobMeta> {
    // textContent, not innerText: the posting is hidden behind the modal by now.
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const pick = (selectors: string[]) => {
        for (const sel of selectors) {
          const text = clean(document.querySelector(sel)?.textContent);
          if (text) return text;
        }
        return '';
      };
      // "<Title> | <Company> | LinkedIn"
      const [docTitle = '', docCompany = ''] = document.title.replace(/^\(\d+\)\s*/, '').split(' | ');
      const header = clean(document.querySelector('[role="dialog"] h2, [role="dialog"] h3')?.textContent);
      return {
        title:
          pick(['.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title', 'main h1']) ||
          clean(docTitle),
        company:
          pick(['.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name']) ||
          clean(docCompany) ||
          (/^apply to (.+)$/i.exec(header)?.[1] ?? ''),
        location: pick(['.job-details-jobs-unified-top-card__primary-description-container .tvm__text']) || undefined,
        descriptionText: pick(['#job-details', '.jobs-description__content', '.jobs-box__html-content']).slice(0, 30000),
      };
    });
  },

  async settle(page) {
    // Each step swaps the modal's body in place; give it a beat to draw.
    await page.waitForTimeout(500);
    await isolateModal(page);
  },

  async extractForm(page) {
    const fields = await extractFields(page, { harvestComboboxOptions: true });
    // "Follow <company> to stay up to date" on Review is not a question for you;
    // beforeAdvance unticks it.
    return fields.filter((f) => !/^follow\b/i.test(f.label.trim()) && !/follow-company/i.test(f.selector + (f.name ?? '')));
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    return {
      resume: files.find((f) => /resume|cv/i.test(fileHint(f))),
      coverLetter: files.find((f) => /cover/i.test(fileHint(f))),
    };
  },

  async beforeAdvance(page) {
    await page
      .evaluate(() => {
        const box = document.querySelector<HTMLInputElement>('#follow-company-checkbox, input[id*="follow-company" i]');
        if (!box?.checked) return;
        const label = box.id ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(box.id)}"]`) : null;
        (label ?? box).click();
      })
      .catch(() => {});
  },

  async submit(page) {
    const byLabel = page.locator('button[aria-label*="submit application" i]:visible');
    if (await byLabel.count()) {
      await byLabel.first().click();
      return;
    }
    await page.getByRole('button', { name: /submit application/i }).first().click();
  },

  notes: [
    'Easy Apply runs on your own LinkedIn session in the shared browser profile; sign in there by hand once.',
    'The posting page is hidden behind the Easy Apply modal while the run works, so only the form shows.',
    'The final step has not been seen in a real run yet, so it always stops for review before submitting.',
  ],

  alwaysReview: true,
};
