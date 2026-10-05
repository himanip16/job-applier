import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';

/**
 * Ashby (jobs.ashbyhq.com/<org>/<uuid>).
 *
 * A React SPA. Fields are rendered from a JSON form definition that the page
 * fetches, so the DOM is generated rather than authored: ids are unstable
 * between renders and there are no meaningful `name` attributes. The generic
 * extractor's label-first strategy is the right approach here, which is why
 * this adapter is thin.
 */
export const ashbyAdapter: AtsAdapter = {
  id: 'ashby',

  matches(url) {
    return /jobs\.ashbyhq\.com/.test(url);
  },

  async openApplicationForm(page, url) {
    // Ashby is the board this flow exists for. Its job URL shows a
    // description behind an Apply button, its application is React-rendered
    // inputs with no <form> wrapper, and some tenants front the whole thing
    // with Cloudflare. Waiting on locator('form') gets none of that right.
    await openApplicationForm(page, url, {
      applyPatterns: [/apply for this job/i],
      formSelectors: ['[class*="_fieldEntry"]', '[class*="application"] input'],
    });
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? document.title;
      const m = /^(.*?)\s*[@|]\s*(.*)$/.exec(og);
      return {
        title: clean(document.querySelector('h1')?.textContent) || clean(m?.[1]) || 'Unknown role',
        company:
          clean(m?.[2]) ||
          location.pathname.split('/').filter(Boolean)[0] ||
          'Unknown',
        location: clean(document.querySelector('[class*="location"]')?.textContent) || undefined,
        descriptionText: clean(document.querySelector('[class*="jobDescription"], main')?.textContent).slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    return extractFields(page, { harvestComboboxOptions: false });
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
    'Generated DOM with unstable ids; matching is label-driven.',
    'Cloudflare Turnstile fronts some tenants; the run waits it out and hands over if it does not clear.',
    'The application mounts only after Apply is clicked, and has no <form> wrapper.',
  ],
};
