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
 *   - the sign-in itself is filled from the saved Apple ID (engine/humanGate.ts,
 *     browser/appleId.ts); Apple's six-digit device code still waits for you.
 *   - after the resume is parsed, a "review" step (`#parsedmodal-review-container`)
 *     shows Contact Information with ordinary labelled inputs (`#profile-firstname`,
 *     `#apply-contact-pref-phone-0`, a native Country/Region `<select>` whose
 *     values are `iso-country-XXX`, `#profile-field-city` ...), "Add education" /
 *     "Add employment" / "Add language" buttons, a Skills search box, and an
 *     "Add files" input (`#attachfile-resume-supportfile`) for a cover letter or
 *     portfolio. `#apply-step-continue-button` ("Continue") moves on.
 *
 * Two controls there are not questions. The Skills search box carries
 * `required` but only searches Apple's skill list - read as a required blank,
 * it stopped the run to ask - so it is left out. The "Add files" input is the
 * only file input on the step, and taking the first file input as the resume
 * attached the resume a second time; it gets the cover letter instead.
 *
 * The last step has not been seen yet, so every run still goes through review.
 */
const SKILL_SEARCH = /apply-skills-typeahead/i;
const SUPPORT_FILE = /supportfile/i;

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
        'jobdetails-responsibilities',
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
    const fields = await extractFields(page, { harvestComboboxOptions: true });
    return fields.filter((f) => !SKILL_SEARCH.test(`${f.name ?? ''} ${f.selector}`));
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    // `attachfile-resume-supportfile` says "resume" too; it is the extras box.
    const extras = files.find((f) => SUPPORT_FILE.test(fileHint(f)));
    const own = files.filter((f) => f !== extras);
    return {
      resume: own.find((f) => /resume|cv/i.test(fileHint(f))) ?? own[0],
      coverLetter: own.find((f) => /cover/i.test(fileHint(f))) ?? extras,
    };
  },

  async submit(page) {
    await page.getByRole('button', { name: /^(submit|submit application|submit resume)$/i }).first().click();
  },

  alwaysReview: true,

  notes: [
    'Signs in with the Apple ID saved in Settings; the six-digit code Apple sends to your devices waits for you the first time.',
    'The Skills search box is skipped, and "Add files" gets the cover letter.',
    'The final step has not been mapped yet, so every run stops for review.',
  ],
};
