import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';

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
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const apply = page.getByRole('button', { name: /apply for this job|^apply$/i });
    if (await apply.count()) await apply.first().click().catch(() => {});
    await page.locator('form').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(800);
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
    'Generated DOM with unstable ids; matching is label-driven.',
    'Cloudflare Turnstile appears on some tenants.',
  ],
};
