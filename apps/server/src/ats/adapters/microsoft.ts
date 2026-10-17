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
 *     With a Microsoft account saved in Settings the run signs in through
 *     "Sign in using Microsoft" itself (engine/humanGate.ts,
 *     browser/microsoftAccount.ts); otherwise it pauses there for you. Either
 *     way the profile keeps the session for every later Microsoft application.
 *   - reCAPTCHA is armed on the page.
 *
 * Behind the sign-in is a multi-step wizard (contact page, screening answers
 * carried over from the job page, acknowledgments). Its quirks are handled in
 * the shared fill/wizard code rather than here: Eightfold dropdowns without a
 * select shell, the legal-name question that rebuilds the fields around it,
 * and locked dropdowns that show their choice beside an empty input. Fields
 * are still matched on their labels, and every run goes through review.
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
    'Signs in with the Microsoft account saved in Settings; without one, or when Microsoft asks for a code, the run waits for you on the sign-in screen.',
    'Fields are matched on their labels, and every Microsoft application stops for your review before it is submitted.',
  ],
};
