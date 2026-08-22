import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';

/**
 * Lever (jobs.lever.co/<org>/<posting-id>).
 *
 * Verified against a live posting in August 2026:
 *   - the posting page and the form are different URLs; the form lives at
 *     `<posting-url>/apply`
 *   - `<form id="application-form" enctype="multipart/form-data" method="POST">`
 *     is a real HTML form, so native semantics work throughout
 *   - field names are stable and human-readable: name, email, phone, org,
 *     location, urls[LinkedIn], resume, comments
 *   - custom questions are `cards[<uuid>][field<N>]`, rendered as genuine
 *     `<select>` and `<textarea>` elements
 *   - both `g-recaptcha-response` and `h-captcha-response` are present;
 *     hCaptcha is the one that is actually wired up on current postings
 *
 * Lever is the easiest of the major boards to drive correctly, because nothing
 * on it is a custom widget.
 */
export const leverAdapter: AtsAdapter = {
  id: 'lever',

  matches(url) {
    return /jobs\.(eu\.)?lever\.co/.test(url);
  },

  async openApplicationForm(page, url) {
    const applyUrl = /\/apply\/?$/.test(url) ? url : `${url.replace(/\/+$/, '')}/apply`;
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#application-form').waitFor({ state: 'visible', timeout: 20_000 });
  },

  async readJobMeta(page): Promise<JobMeta> {
    // The description lives on the posting page, one level up from /apply.
    const postingUrl = page.url().replace(/\/apply\/?$/, '');
    const meta = await page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '';
      const m = /^(.*?)\s+-\s+(.*)$/.exec(og); // "Company - Title"
      return {
        company: clean(m?.[1]) || location.pathname.split('/').filter(Boolean)[0] || 'Unknown',
        title: clean(m?.[2]) || clean(document.querySelector('h2, .posting-headline h2')?.textContent) || 'Unknown role',
        location: clean(document.querySelector('.location, .posting-categories .location')?.textContent) || undefined,
      };
    });

    let descriptionText = '';
    const detail = await page.context().newPage();
    try {
      await detail.goto(postingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      descriptionText = await detail.evaluate(() =>
        (document.querySelector('.content, .posting-page, main')?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 30000),
      );
    } catch {
      // A missing description degrades the cover letter but does not block.
    } finally {
      await detail.close().catch(() => {});
    }

    return { ...meta, descriptionText };
  },

  async extractForm(page) {
    // Lever is all native controls, so there is no combobox menu to open.
    return extractFields(page, { harvestComboboxOptions: false });
  },

  fileInputs(fields) {
    return {
      resume: fields.find((f) => f.kind === 'FILE' && /resume|cv/i.test(f.label)),
      coverLetter: fields.find((f) => f.kind === 'FILE' && /cover/i.test(f.label)),
    };
  },

  async submit(page) {
    const btn = page
      .locator('#application-form button[type="submit"], #btn-submit, button.postings-btn')
      .first();
    const target = (await btn.count()) ? btn : page.getByRole('button', { name: /submit/i }).first();
    await target.scrollIntoViewIfNeeded();
    await target.click();
  },

  notes: [
    'Native HTML form throughout - the most reliable board to automate.',
    'hCaptcha is wired up on current postings and will need you at submit time.',
    'Custom questions are cards[<uuid>][fieldN]; their labels vary per company, so the answer bank carries them.',
  ],
};
