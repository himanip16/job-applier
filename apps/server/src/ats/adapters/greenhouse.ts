import type { Page } from 'playwright';
import type { FormField } from '@ja/shared';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';
import type { AtsAdapter, JobMeta } from '../types.js';

/**
 * Greenhouse job boards (job-boards.greenhouse.io, boards.greenhouse.io, and
 * the same app embedded under a company's own domain).
 *
 * Verified against a live board in August 2026. What the markup actually looks
 * like:
 *   - the form is `#application-form`, a React (Remix) app
 *   - core fields carry stable ids: #first_name, #last_name, #email, #phone,
 *     #country, #candidate-location, #resume, #cover_letter
 *   - every custom question is `#question_<numeric id>`, and multi-selects get
 *     a `[]` suffix: `#question_19433796004[]`
 *   - EEO fields are #gender, #hispanic_ethnicity, #veteran_status,
 *     #disability_status
 *   - dropdowns are react-select (`.select__control`, role="combobox"), NOT
 *     `<select>`, so Playwright's selectOption does not apply
 *   - a `g-recaptcha-response` textarea sits on the form: reCAPTCHA is armed
 *
 * The official Job Board API has a POST /applications endpoint, but it
 * authenticates with the *employer's* board token. A candidate cannot use it.
 * Driving the real form is the only route available from this side.
 */
export const greenhouseAdapter: AtsAdapter = {
  id: 'greenhouse',

  matches(url) {
    return /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io/.test(url) || /greenhouse\.io\/embed\/job_app/.test(url);
  },

  async openApplicationForm(page, url) {
    await openApplicationForm(page, url, {
      formSelectors: ['#application-form'],
      applyPatterns: [/apply for this job/i],
    });
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const title =
        clean(document.querySelector('h1, .app-title, .job__title h1')?.textContent) ||
        clean(document.title).replace(/^Job Application for /i, '');
      const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '';
      // "Job Application for <Title> at <Company>"
      const m = /(?:Job Application for )?(.*?) at (.*)$/i.exec(og || document.title);
      const company =
        clean(document.querySelector('.company-name, [class*="company"]')?.textContent) ||
        clean(m?.[2]) ||
        location.pathname.split('/').filter(Boolean)[0] ||
        'Unknown';
      const body = document.querySelector('#content, .job__description, .job-post, main');
      return {
        title: clean(m?.[1]) || title || 'Unknown role',
        company: company.replace(/[-_]/g, ' '),
        location: clean(document.querySelector('.location, .job__location')?.textContent) || undefined,
        descriptionText: clean(body?.textContent).slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    const fields = await extractFields(page, { harvestComboboxOptions: true });
    return fields.map(refineGreenhouseField);
  },

  fileInputs(fields) {
    return {
      resume: fields.find((f) => f.kind === 'FILE' && /resume|cv/i.test(f.label + f.selector)),
      coverLetter: fields.find((f) => f.kind === 'FILE' && /cover/i.test(f.label + f.selector)),
    };
  },

  async submit(page) {
    const btn = page
      .locator('#application-form button[type="submit"], button[type="submit"]')
      .filter({ hasText: /submit/i })
      .first();
    const target = (await btn.count()) ? btn : page.getByRole('button', { name: /submit application/i }).first();
    await target.scrollIntoViewIfNeeded();
    await target.click();
  },

  notes: [
    'Dropdowns are react-select comboboxes, driven by click-type-pick rather than selectOption.',
    'reCAPTCHA is present on the standard board. Invisible mode often passes on a warmed-up profile; when it challenges, the run stops for you.',
    'Custom questions are #question_<id>; their wording is set per-company, which is exactly what the answer bank is for.',
  ],
};

/**
 * Greenhouse names its core fields predictably, so we can attach canonical keys
 * with certainty instead of leaning on label regexes.
 */
function refineGreenhouseField(field: FormField): FormField {
  const idHint = field.label.toLowerCase();
  const known: Record<string, string> = {
    first_name: 'identity.first_name',
    last_name: 'identity.last_name',
    email: 'contact.email',
    phone: 'contact.phone',
    country: 'location.country',
    'candidate-location': 'location.current',
    gender: 'eeo.gender',
    hispanic_ethnicity: 'eeo.race',
    veteran_status: 'eeo.veteran',
    disability_status: 'eeo.disability',
  };
  // The extractor rewrote the selector to a data attribute, so recover the
  // original id from the label where Greenhouse mirrors it into aria-label.
  for (const [domId, key] of Object.entries(known)) {
    if (idHint.replace(/\s+/g, '_') === domId || idHint === domId.replace(/_/g, ' ')) {
      return { ...field, canonicalKey: key, sensitive: key.startsWith('eeo.') };
    }
  }
  return field;
}
