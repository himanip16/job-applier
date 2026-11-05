import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';

/**
 * Qualcomm Careers (careers.qualcomm.com), an Eightfold tenant like Microsoft.
 *
 * Checked live in October 2026:
 *   - a posting is /careers/job/<pid>; its "Apply Now" links to
 *     /careers/apply?pid=<pid>, so the adapter opens that directly.
 *     qualcomm.eightfold.ai redirects to careers.qualcomm.com.
 *   - the apply page puts Eightfold's candidate sign-in modal
 *     (#candidate-auth-v2-modal) in front of the form: an email box with
 *     Continue, "Sign in using Google", "Create an account". browser/blockers.ts
 *     reads that modal as a sign-in wall, so the saved job site password signs
 *     in or the run waits for you there.
 *   - behind it is one page: resume (pick a saved one or upload), contact,
 *     Country, an optional gender radio, "Position Location", right to work,
 *     close and extended relatives at Qualcomm, and an "I consent" box. The
 *     page auto-saves drafts to the candidate dashboard.
 *
 * The widgets are the same Eightfold dropdowns as Microsoft's, handled in the
 * shared fill code. Every run goes through review until a submit has been seen.
 */
export const qualcommAdapter: AtsAdapter = {
  id: 'qualcomm',

  matches(url) {
    return /careers\.qualcomm\.com|qualcomm\.eightfold\.ai/i.test(url);
  },

  async openApplicationForm(page, url) {
    const pid = /\/job\/(\d+)/.exec(url)?.[1] ?? new URL(url).searchParams.get('pid');
    const target = pid ? `https://careers.qualcomm.com/careers/apply?pid=${pid}&domain=qualcomm.com` : url;
    await openApplicationForm(page, target, { applyPatterns: [/^apply now$/i, /^apply$/i] });
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      // The posting's title is "<Title> | Qualcomm"; the apply page's is the
      // site's, but its job cart names the role and its locations.
      const cart = clean(document.querySelector('[class*="jobCartPositionName"]')?.textContent);
      const fromTitle = /\|\s*Qualcomm\s*$/i.test(document.title) && !/^Qualcomm Careers/i.test(document.title)
        ? clean(document.title.replace(/\s*\|\s*Qualcomm\s*$/i, ''))
        : '';
      const locations = Array.from(document.querySelectorAll('[class*="locationItem"]'))
        .map((el) => clean(el.textContent))
        .filter(Boolean);
      return {
        title: cart || fromTitle || clean(document.querySelector('h1')?.textContent) || 'Unknown role',
        company: 'Qualcomm',
        location: locations.length ? locations.join('; ') : undefined,
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
    'Qualcomm asks you to sign in first (email, or Google). With a job site password saved it signs in itself; otherwise the run waits for you on that screen.',
    'Fields are matched on their labels, and every Qualcomm application stops for your review before it is submitted.',
  ],
};
