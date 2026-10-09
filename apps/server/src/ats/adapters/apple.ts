import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';

/**
 * Apple Careers (jobs.apple.com).
 *
 * Checked live in October 2026:
 *   - a posting is /<locale>/details/<roleNumber>/<slug>; both "Submit Resume"
 *     links on it (`#...-jobdetailssubmitresume`) go to
 *     /app/<locale>/apply/<roleNumber>, so the adapter opens that directly.
 *   - that URL redirects to an Apple ID sign-in on idmsa.apple.com. The run
 *     pauses there; sign in once in the open browser and the profile keeps
 *     the session for every later Apple application.
 *   - posting fields have stable ids: `#jobdetails-postingtitle`,
 *     `#jobdetails-joblocation`, `#jobdetails-jobsummary`,
 *     `#jobdetails-jobdescription`, `#jobdetails-minimumqualifications`,
 *     `#jobdetails-preferredqualifications`.
 *
 * The form behind the sign-in has not been seen yet, so extraction is the
 * label-driven default and every run goes through review.
 */
export const appleAdapter: AtsAdapter = {
  id: 'apple',

  matches(url) {
    return /^https?:\/\/jobs\.apple\.com\//i.test(url);
  },

  async openApplicationForm(page, url) {
    const m = /jobs\.apple\.com\/(?:app\/)?([a-z]{2}-[a-z]{2})\/(?:details|apply)\/([0-9A-Z-]+)/i.exec(url);
    const target = m ? `https://jobs.apple.com/app/${m[1]}/apply/${m[2]}` : url;
    await openApplicationForm(page, target, { applyPatterns: [/^submit resume$/i, /^apply now$/i] });
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const byId = (id: string) => clean(document.getElementById(id)?.innerText);
      // Only the posting page carries these. On the apply page they are blank,
      // and the runner keeps what discovery already stored on the job.
      const description = [
        'jobdetails-jobsummary',
        'jobdetails-jobdescription',
        'jobdetails-minimumqualifications',
        'jobdetails-preferredqualifications',
      ]
        .map(byId)
        .filter(Boolean)
        .join('\n\n');
      return {
        title: byId('jobdetails-postingtitle'),
        company: 'Apple',
        location: byId('jobdetails-joblocation') || undefined,
        descriptionText: description.slice(0, 30000),
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
    await page.getByRole('button', { name: /^(submit|submit application|submit resume)$/i }).first().click();
  },

  alwaysReview: true,

  notes: [
    'Needs an Apple ID sign-in: the run pauses at idmsa.apple.com the first time; sign in once in the open browser.',
    'The form behind the sign-in has not been mapped yet, so fields are matched on their labels.',
  ],
};
