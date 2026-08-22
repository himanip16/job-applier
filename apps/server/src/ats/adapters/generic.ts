import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';

/**
 * Fallback for anything unrecognised: a company's own careers page, a smaller
 * ATS, a WordPress form.
 *
 * There is no site knowledge here at all - it reads whatever form is on the
 * page and lets the resolver work off labels. Success rate is materially lower
 * than the named adapters, so the runner always routes these through review
 * before submitting.
 */
export const genericAdapter: AtsAdapter = {
  id: 'generic',

  matches() {
    return true;
  },

  async openApplicationForm(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // If the landing page has no form, follow the most apply-looking link once.
    const hasForm = await page.locator('form input, form textarea').count();
    if (!hasForm) {
      const apply = page
        .getByRole('link', { name: /apply|application/i })
        .or(page.getByRole('button', { name: /apply|application/i }));
      if (await apply.count()) {
        await apply.first().click({ timeout: 8000 }).catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
    }
    await page.waitForTimeout(1000);
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const host = location.hostname.replace(/^(www|jobs|careers|apply)\./, '').split('.')[0] ?? 'Unknown';
      return {
        title: clean(document.querySelector('h1')?.textContent) || clean(document.title),
        company:
          clean(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')) ||
          host,
        location: undefined,
        descriptionText: clean(document.querySelector('main, article, body')?.textContent).slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    return extractFields(page, { harvestComboboxOptions: true });
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    return {
      resume: files.find((f) => /resume|cv/i.test(f.label)) ?? files[0],
      coverLetter: files.find((f) => /cover/i.test(f.label)),
    };
  },

  async submit(page) {
    const byRole = page.getByRole('button', { name: /submit|send application|apply now/i });
    if (await byRole.count()) {
      await byRole.first().click();
      return;
    }
    await page.locator('form button[type="submit"], form input[type="submit"]').first().click();
  },

  notes: [
    'No site-specific knowledge: fields are matched purely on their labels.',
    'Always routed through review before submit, whatever your global setting says.',
  ],
};
