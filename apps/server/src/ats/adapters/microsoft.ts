import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';

/**
 * Microsoft Careers (apply.careers.microsoft.com), an Eightfold tenant.
 *
 * Checked live in September 2026:
 *   - a posting is /careers/job/<pid>; its "Apply now" goes to
 *     /careers/apply?pid=<pid>, so the adapter opens that directly.
 *   - that page puts a candidate sign-in modal in front of everything ("Sign
 *     in using Microsoft / LinkedIn / Google / Facebook", "Create an account").
 *     The run pauses on it; sign in once in the open browser and the profile
 *     keeps the session for every later Microsoft application.
 *   - reCAPTCHA is armed on the page.
 *
 * The form behind the sign-in has not been seen yet, so extraction is the
 * label-driven default and every run goes through review.
 */
export const microsoftAdapter: AtsAdapter = {
  id: 'microsoft',

  matches(url) {
    return /apply\.careers\.microsoft\.com|jobs\.careers\.microsoft\.com|careers\.microsoft\.com\/.*\/job/i.test(url);
  },

  async openApplicationForm(page, url) {
    const pid = /\/job\/(\d+)/.exec(url)?.[1] ?? new URL(url).searchParams.get('pid');
    const target = pid && /apply\.careers\.microsoft\.com/i.test(url)
      ? `https://apply.careers.microsoft.com/careers/apply?pid=${pid}`
      : url;
    await openApplicationForm(page, target, { applyPatterns: [/^apply now$/i, /^apply$/i] });
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      // "<Title> | Microsoft Careers"; the first h1 on a posting is "Single Position".
      const title =
        clean(document.title.replace(/\s*\|\s*Microsoft Careers\s*$/i, '')) ||
        clean(Array.from(document.querySelectorAll('h1')).pop()?.textContent) ||
        'Unknown role';
      return {
        title,
        company: 'Microsoft',
        location: undefined,
        descriptionText: clean(document.querySelector('main')?.textContent).slice(0, 30000),
      };
    });
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
    await page.getByRole('button', { name: /^(submit|submit application|apply)$/i }).first().click();
  },

  alwaysReview: true,

  notes: [
    'Needs a Microsoft careers sign-in: the run pauses on the sign-in screen the first time; sign in once in the open browser.',
    'The form behind the sign-in has not been mapped yet, so fields are matched on their labels.',
  ],
};
