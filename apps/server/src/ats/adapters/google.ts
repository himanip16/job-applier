import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';

/**
 * Google Careers (www.google.com/about/careers/applications/...).
 *
 * Read from the DOM a real run saved in September 2026:
 *   - Apply sends you through accounts.google.com first. The run pauses there;
 *     sign in once in the open browser and the profile keeps the session.
 *   - The application is a four-step flow rendered as tabs:
 *     `[role="tab"][aria-label^="Step "]` - Careers profile, Role Information,
 *     Voluntary self-identification, Review & apply.
 *   - Navigation is icon buttons named only by aria-label: "Back", "Save",
 *     "Next". Next stays disabled until the step's required answers are in.
 *   - Qualification questions are `[role="radiogroup"][aria-required]` with the
 *     question as plain text in the element just before the group (and in the
 *     radios' `name`), Yes / No / Not sure.
 *
 * The final Submit control on the Review step has not been seen in a saved
 * page yet, so submit() looks for it by name, and the runner's own advance
 * detection is what normally presses it.
 */
export const googleAdapter: AtsAdapter = {
  id: 'google',

  matches(url) {
    return /^https?:\/\/(www\.)?google\.com\/about\/careers\//i.test(url) || /careers\.google\.com/i.test(url);
  },

  async openApplicationForm(page, url) {
    await openApplicationForm(page, url, {
      applyPatterns: [/^apply$/i, /^apply now$/i, /apply for this (job|role)/i],
      formSelectors: ['[role="tab"][aria-label^="Step "]', '[role="radiogroup"]'],
    });
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      // "Software Engineer III, Infrastructure, ... - Sunnyvale"
      const h1 = clean(document.querySelector('h1')?.textContent);
      const m = /^(.*?)\s+-\s+([^-]+)$/.exec(h1);
      return {
        title: clean(m?.[1]) || h1 || clean(document.title) || 'Unknown role',
        company: 'Google',
        location: clean(m?.[2]) || undefined,
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
    const byName = page.getByRole('button', { name: /^(submit|submit application|apply)$/i });
    await byName.first().click();
  },

  alwaysReview: true,

  notes: [
    'Needs a Google sign-in: the run pauses at accounts.google.com the first time; sign in once in the open browser.',
    'Four steps (profile, role questions, self-identification, review); Next unlocks once each step is answered.',
  ],
};
