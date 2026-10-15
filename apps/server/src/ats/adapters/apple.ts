import { fileHint } from '../types.js';
import type { Page } from 'playwright';
import type { FormField } from '@ja/shared';
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
 *
 * The form is three steps, named in `.apply-progress-steps` with the current
 * one `aria-current="step"`: Add Resume, Profile Information, Review & Submit.
 *
 *   - Add Resume shows the resume already on the Apple profile, and its
 *     forward button (`#apply-step-continue-button`) says "Submit". Read as the
 *     final submit, it ended every run on step one, so isFinalStep asks the
 *     progress tracker instead.
 *   - Profile Information is the Apple profile, one section per topic. A
 *     section that needs something opens as an inline editor with its own
 *     Save (`#profile-employments-saveButton`,
 *     `#profile-mobilityPreferences-saveButton`), pressed before Continue.
 *     The employment editor's fields are numbered by id
 *     (`#profile-employer-0-suggestion-textbox`, `#profile-jobtitle-0`,
 *     `#profile-startmonth-0`, ...) and its date dropdowns are labelled only
 *     "Month" / "Year", so they are renamed "Employment 1: Start date month"
 *     and so on, which the saved `employment.N` facts answer.
 *
 * The Review & Submit step has not been seen yet, so every run still stops for
 * review.
 */
/** The apply wizard itself, on any of its steps. */
const APPLY_FORM = '#apply-container .apply-progress-steps, #parsedmodal-review-container';
const SKILL_SEARCH = /apply-skills-typeahead/i;
const SUPPORT_FILE = /supportfile/i;
/** The Save of a profile section's inline editor. */
const SECTION_SAVE = 'button[id^="profile-"][id$="-saveButton"]';

/**
 * The employment editor's controls, by id, and what each asks in the words
 * answerFromHistory reads. "Current Employer" is not called that: it would
 * read as the company name.
 */
const EMPLOYMENT_FIELD: Array<[RegExp, string]> = [
  [/^profile-employer-(\d+)/, 'Employer'],
  [/^profile-jobtitle-(\d+)$/, 'Job Title'],
  [/^profile-startmonth-(\d+)$/, 'Start date month'],
  [/^profile-startyear-(\d+)$/, 'Start date year'],
  [/^profile-endmonth-(\d+)$/, 'End date month'],
  [/^profile-endyear-(\d+)$/, 'End date year'],
  [/^profile-job-description-(\d+)$/, 'Job Description'],
  [/^profile-currentemployer-(?:yes|no)-\d+$|^currentEmployer(\d+)$/, 'Do you still work here?'],
];

export const appleAdapter: AtsAdapter = {
  id: 'apple',

  matches(url) {
    return /^https?:\/\/jobs\.apple\.com\//i.test(url);
  },

  async openApplicationForm(page, url) {
    const m = /jobs\.apple\.com\/(?:app\/)?([a-z]{2}-[a-z]{2})\/(?:details|apply)\/([0-9A-Z-]+)/i.exec(url);
    const target = m ? `https://jobs.apple.com/app/${m[1]}/apply/${m[2]}` : url;
    await openApplicationForm(page, target, {
      // Add Resume has no inputs when the profile already holds a resume, so
      // the generic "two fillable inputs" test called it no form at all.
      formSelectors: [APPLY_FORM],
      applyPatterns: [/^submit resume$/i, /^apply now$/i],
    });
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
    const kept = fields.filter((f) => !SKILL_SEARCH.test(`${f.name ?? ''} ${f.selector}`));
    return nameEmploymentFields(page, kept);
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

  async isFinalStep(page) {
    return page.evaluate(() => {
      const steps = Array.from(document.querySelectorAll('.apply-progress-steps > li'));
      const current = steps.findIndex((li) => li.getAttribute('aria-current') === 'step');
      // No tracker: nothing to go on, so believe the button.
      return steps.length === 0 || current === steps.length - 1;
    });
  },

  async beforeAdvance(page) {
    await saveOpenSections(page);
  },

  async submit(page) {
    const own = page.locator('#apply-step-continue-button');
    if (await own.isVisible().catch(() => false)) return own.click();
    await page.getByRole('button', { name: /^(submit|submit application|submit resume)$/i }).first().click();
  },

  alwaysReview: true,

  notes: [
    'Signs in with the Apple ID saved in Settings; the six-digit code Apple sends to your devices waits for you the first time.',
    'The Skills search box is skipped, and "Add files" gets the cover letter.',
    'Add Resume keeps the resume already on your Apple profile; its "Submit" only moves to the next step.',
    'Profile sections opened for editing (Employment, Mobility) are saved before Continue. Only the first employment row is filled.',
    'Employer is a search box: check it took your company before submitting.',
    'The Review & Submit step has not been mapped yet, so every run stops for review.',
  ],
};

/** "Employment 1: Start date month" for each employment editor control, from its id. */
async function nameEmploymentFields(page: Page, fields: FormField[]): Promise<FormField[]> {
  const ids = await page.evaluate(
    (selectors) => selectors.map((s) => document.querySelector(s)?.id ?? ''),
    fields.map((f) => f.selector),
  );
  return fields.map((field, i) => {
    for (const key of [ids[i] ?? '', field.name ?? '']) {
      for (const [pattern, question] of EMPLOYMENT_FIELD) {
        const m = pattern.exec(key);
        if (!m) continue;
        // The radio's own ids carry a random suffix; its group name has the row.
        const row = m[1] ?? /(\d+)$/.exec(field.name ?? '')?.[1] ?? '0';
        return { ...field, label: `Employment ${Number(row) + 1}: ${question}`, canonicalKey: undefined };
      }
    }
    return field;
  });
}

/**
 * Press Save on every open section editor. Each closes when Apple accepts it;
 * one that stays open has a complaint on it, which Continue then reports.
 */
async function saveOpenSections(page: Page): Promise<void> {
  const saves = page.locator(`${SECTION_SAVE}:visible`);
  for (let n = await saves.count(); n > 0; n--) {
    const save = saves.first();
    const id = await save.getAttribute('id').catch(() => null);
    if (!id) return;
    await save.click({ timeout: 5000 }).catch(() => {});
    const closed = await page
      .locator(`#${id}`)
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!closed) return;
  }
}
