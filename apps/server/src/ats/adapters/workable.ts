import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';

/**
 * Workable (apply.workable.com/<org>/j/<shortcode>).
 *
 * Mixed markup: native inputs for the basics, custom radio "cards" for
 * multiple choice, and a drag-and-drop resume zone that is backed by a real
 * (hidden) file input, so setInputFiles still works.
 *
 * Checked live in October 2026 (apply.workable.com/leucine/j/27A3674A6F):
 *   - the posting's "Apply for this job" (`[data-ui="apply-button"]`) and its
 *     APPLICATION tab both go to /<org>/j/<shortcode>/apply/, so the adapter
 *     opens that directly. The form is one page,
 *     `form[data-ui="application-form"]`, ending in "Submit application".
 *   - the apply page keeps the title (`[data-ui="job-title"]`) and location
 *     but not the description, and its `main` is the form. Read as the
 *     description, the form's own text ("AUTOFILL APPLICATION ... First name")
 *     replaced the real one. The description comes from Workable's own job
 *     endpoint instead, /api/v2/accounts/<org>/jobs/<shortcode>.
 *   - the company name is only in the logo's alt text; the URL slug
 *     ("leucine") is the fallback.
 *   - a cookie banner (`[data-ui="cookie-consent"]`) with a backdrop shows on
 *     a first visit; it is declined.
 *   - Cloudflare Turnstile is loaded on the form and checks on submit.
 */
const APPLY_FORM = 'form[data-ui="application-form"]';

export const workableAdapter: AtsAdapter = {
  id: 'workable',

  matches(url) {
    return /apply\.workable\.com|workable\.com\/j\//.test(url);
  },

  async openApplicationForm(page, url) {
    const m = /^(https?:\/\/apply\.workable\.com\/[^/?#]+\/j\/[0-9A-Z]+)/i.exec(url);
    const target = m ? `${m[1]}/apply/` : url;
    await openApplicationForm(page, target, {
      formSelectors: [APPLY_FORM],
      applyPatterns: [/apply for this job/i],
    });
    const decline = page.locator('[data-ui="cookie-consent-decline"]');
    if (await decline.isVisible().catch(() => false)) await decline.click({ timeout: 5000 }).catch(() => {});
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(async () => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const text = (sel: string) => clean(document.querySelector<HTMLElement>(sel)?.innerText);
      // A space at each block break, or "Celestara</p><p>12 of" reads "Celestara12 of".
      const fromHtml = (html: string | undefined) =>
        clean(
          new DOMParser().parseFromString((html ?? '').replace(/<(\/p|\/li|\/h\d|br)\b/gi, ' $&'), 'text/html').body
            .textContent,
        );
      const [org, , shortcode] = location.pathname.split('/').filter(Boolean);

      // The posting page has these sections; the apply page does not.
      let description = ['job-description', 'job-requirements', 'job-benefits']
        .map((ui) => text(`[data-ui="${ui}"]`))
        .filter(Boolean)
        .join('\n\n');
      if (!description && org && shortcode) {
        const job = await fetch(`/api/v2/accounts/${org}/jobs/${shortcode}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (job) {
          description = [job.description, job.requirements, job.benefits]
            .map(fromHtml)
            .filter(Boolean)
            .join('\n\n');
        }
      }

      const logo = document.querySelector<HTMLImageElement>(
        '[data-ui="company-logo"] img, [data-ui="header-logo"] img',
      );
      return {
        title: text('[data-ui="job-title"]') || text('h1') || 'Unknown role',
        company: clean(logo?.alt) || text('[data-ui="company-name"]') || org || 'Unknown',
        location: text('[data-ui="job-location"]') || undefined,
        // Blank rather than the form's text: the runner then keeps the
        // description discovery stored.
        descriptionText: description.slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    return extractFields(page, { harvestComboboxOptions: true });
  },

  fileInputs(fields) {
    return {
      resume: fields.find((f) => f.kind === 'FILE' && /resume|cv/i.test(fileHint(f))),
      coverLetter: fields.find((f) => f.kind === 'FILE' && /cover/i.test(fileHint(f))),
    };
  },

  async submit(page) {
    await page.getByRole('button', { name: /submit application|^submit$/i }).first().click();
  },

  notes: [
    'Opens the /apply/ page directly and declines the cookie banner.',
    'Resume upload is a drop zone over a hidden file input.',
    'Multiple-choice questions render as styled radio cards, handled as a radio group.',
    'Cloudflare Turnstile runs on submit; if it challenges, the run hands over to you.',
  ],
};
