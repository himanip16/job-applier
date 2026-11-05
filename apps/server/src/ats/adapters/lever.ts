import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';

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
    // Lever's form is its own URL, so this normally skips the Apply click
    // entirely - but it still needs the interstitial wait.
    const applyUrl = /\/apply\/?$/.test(url) ? url : `${url.replace(/\/+$/, '')}/apply`;
    await openApplicationForm(page, applyUrl, { formSelectors: ['#application-form'] });
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
    const fields = await extractFields(page, { harvestComboboxOptions: false });
    // A <label> wraps the whole question, so its text picks up whatever else
    // sits inside: the location search's hidden "No location found... Loading"
    // and a question's description ("Community BackgroundSelect all that
    // apply"). The caption alone is the `.application-label`.
    const seen = await page
      .evaluate(
        (selectors) =>
          selectors.map((sel) => {
            const el = document.querySelector(sel);
            const box = el?.closest('li.application-question')?.querySelector('.application-label');
            let caption = '';
            if (box) {
              const copy = box.cloneNode(true) as HTMLElement;
              copy.querySelectorAll('.required, .description').forEach((n) => n.remove());
              caption = (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
            }
            return { caption, location: !!el?.classList.contains('location-input') };
          }),
        fields.map((f) => f.selector),
      )
      .catch(() => fields.map(() => ({ caption: '', location: false })));
    return fields.map((f, i) => {
      const { caption, location } = seen[i] ?? { caption: '', location: false };
      // Only where the caption is the start of what was read: a checkbox
      // inside a group ("Custom" under Pronouns) keeps its own label.
      const label = caption && f.label !== caption && f.label.startsWith(caption) ? caption : f.label;
      // Current location is a search-and-pick: typed words are wiped on blur
      // unless a result is chosen, which also fills the hidden selectedLocation.
      if (location) {
        return { ...f, label, widget: 'react-select' as const, optionContainerSelector: '.dropdown-results', options: undefined };
      }
      return { ...f, label };
    });
  },

  fileInputs(fields) {
    return {
      resume: fields.find((f) => f.kind === 'FILE' && /resume|cv/i.test(fileHint(f))),
      coverLetter: fields.find((f) => f.kind === 'FILE' && /cover/i.test(fileHint(f))),
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
    'Current location is a search-and-pick: the city is typed and the matching result picked.',
    'Custom questions are cards[<uuid>][fieldN]; their labels vary per company, so the answer bank carries them.',
  ],
};
