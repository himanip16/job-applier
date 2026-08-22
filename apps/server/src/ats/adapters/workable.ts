import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';

/**
 * Workable (apply.workable.com/<org>/j/<id>).
 *
 * Mixed markup: native inputs for the basics, custom radio "cards" for
 * multiple choice, and a drag-and-drop resume zone that is backed by a real
 * (hidden) file input, so setInputFiles still works.
 */
export const workableAdapter: AtsAdapter = {
  id: 'workable',

  matches(url) {
    return /apply\.workable\.com|workable\.com\/j\//.test(url);
  },

  async openApplicationForm(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const apply = page.getByRole('link', { name: /apply for this job/i }).or(
      page.getByRole('button', { name: /apply/i }),
    );
    if (await apply.count()) await apply.first().click().catch(() => {});
    await page.locator('form').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(600);
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      return {
        title: clean(document.querySelector('h1')?.textContent) || 'Unknown role',
        company:
          clean(document.querySelector('[data-ui="company-name"], header a')?.textContent) ||
          location.pathname.split('/').filter(Boolean)[0] ||
          'Unknown',
        location: clean(document.querySelector('[data-ui="job-location"]')?.textContent) || undefined,
        descriptionText: clean(document.querySelector('[data-ui="job-description"], main')?.textContent).slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    return extractFields(page, { harvestComboboxOptions: true });
  },

  fileInputs(fields) {
    return {
      resume: fields.find((f) => f.kind === 'FILE' && /resume|cv/i.test(f.label)),
      coverLetter: fields.find((f) => f.kind === 'FILE' && /cover/i.test(f.label)),
    };
  },

  async submit(page) {
    await page.getByRole('button', { name: /submit application|^submit$/i }).first().click();
  },

  notes: [
    'Resume upload is a drop zone over a hidden file input.',
    'Multiple-choice questions render as styled radio cards, handled as a radio group.',
  ],
};
