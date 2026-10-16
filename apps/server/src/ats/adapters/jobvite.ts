import type { Page } from 'playwright';
import type { FormField } from '@ja/shared';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';

/**
 * Jobvite's hosted careers site (jobs.jobvite.com/<company>/job/<id>).
 * Nutanix uses it; its own careers site sits behind a bot wall.
 *
 * Checked live on Nutanix's posting oEnXAfwi in October 2026:
 *   - `<posting>/apply` opens first on "Data Consent": a `#jv-country-select`
 *     of consent policies (Nutanix has one, "All Locations (English)"), whose
 *     choice reveals a privacy-notice acknowledgement with Submit / I Decline.
 *     It is accepted here; the application form is only drawn after it.
 *   - The form is one AngularJS page: native inputs and selects with ids
 *     `jv-field-<eid>` and `<label for>`, a "Send Application" submit.
 *   - The resume is a "Select" menu (File / Dropbox / paste ...). Its file
 *     input `#file-input-0` sits in a menu that stays hidden until the menu
 *     opens, so the form reader never sees it; the same goes for the cover
 *     letter's under "Add Cover Letter". Both are found here by their menu's
 *     wording and fed directly; their `onchange` starts Jobvite's upload.
 *   - Gender is a radio group whose inputs are `visibility: hidden` inside a
 *     drawn `<label>`; clicking the label picks it.
 *   - No captcha on the page.
 */

const CONSENT_SELECT = '#jv-country-select';
const FORM_FIELD = '[id^="jv-field-"]';
const FILE_ATTR = 'data-ja-jv-file';
const SETTLE_MS = 20_000;

/** `https://jobs.jobvite.com/<company>/job/<id>`, without `/apply` or a query. */
function postingUrl(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/(\/job\/[^/]+)\/.*$/, '$1');
  return u.toString();
}

/** Wait for the consent step or the form to draw. Bounded. */
async function settle(page: Page): Promise<void> {
  await page
    .locator(`${CONSENT_SELECT}, ${FORM_FIELD}`)
    .first()
    .waitFor({ state: 'visible', timeout: SETTLE_MS })
    .catch(() => {});
}

/**
 * Pick a consent policy and acknowledge the privacy notice. Prefers a policy
 * for India, then an all-locations one, then the first offered.
 */
async function acceptConsent(page: Page): Promise<boolean> {
  const select = page.locator(CONSENT_SELECT).first();
  if (!(await select.isVisible().catch(() => false))) return false;
  const options = await select.evaluate((el) =>
    Array.from((el as HTMLSelectElement).options)
      .filter((o) => o.value)
      .map((o) => ({ value: o.value, label: (o.textContent ?? '').trim() })),
  );
  const pick =
    options.find((o) => /\bindia\b/i.test(o.label)) ??
    options.find((o) => /all locations/i.test(o.label)) ??
    options[0];
  if (!pick) throw new Error('Jobvite consent step offers no location to choose.');
  await select.selectOption(pick.value);
  const accept = page
    .locator('form[name="consentForm"] button[type="submit"]')
    .filter({ hasText: /submit|accept|agree|continue/i })
    .first();
  await accept.waitFor({ state: 'visible', timeout: 10_000 });
  await accept.click();
  await page.locator(FORM_FIELD).first().waitFor({ state: 'visible', timeout: SETTLE_MS });
  return true;
}

/** Mark the two hidden file inputs as resume / cover letter, and say which exist. */
async function markFileInputs(page: Page): Promise<Array<'resume' | 'cover_letter'>> {
  return page.evaluate((attr) => {
    const found: Array<'resume' | 'cover_letter'> = [];
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))) {
      // Each menu is its own `#attachmentDropdown`, detached from the section
      // it serves, and names its document: "Type or Paste Resume".
      const menu = input.closest('.jv-add-attachment')?.textContent ?? '';
      const place = /cover letter/i.test(menu) ? 'cover_letter' : /resume|\bcv\b/i.test(menu) ? 'resume' : null;
      if (!place || found.includes(place)) continue;
      input.setAttribute(attr, place);
      found.push(place);
    }
    return found;
  }, FILE_ATTR);
}

export const jobviteAdapter: AtsAdapter = {
  id: 'jobvite',

  matches(url) {
    return /^https?:\/\/jobs\.jobvite\.com\/[^/]+\/job\//i.test(url);
  },

  async openApplicationForm(page, url) {
    await page.goto(`${postingUrl(url)}/apply`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page);
    await acceptConsent(page);
    await settle(page);
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      // "Nutanix Careers - Apply for Systems Engineer – Enterprise, Milan"
      const [site, rest] = document.title.split(/\s+-\s+/, 2);
      // "Sales | Milan, Italy | Req.Num.: 32888", the parts split by
      // `.jv-inline-separator` spans; the location is the second.
      const metaEl = document.querySelector('.jv-apply-meta, .jv-job-detail-meta');
      const parts: string[] = [''];
      metaEl?.childNodes.forEach((n) => {
        if ((n as Element).classList?.contains('jv-inline-separator')) parts.push('');
        else parts[parts.length - 1] += n.textContent ?? '';
      });
      const place = parts.map(clean).find((p, i) => i > 0 && p && !/req\.?\s*num/i.test(p));
      return {
        title:
          clean(document.querySelector('h2.jv-header')?.textContent) ||
          clean(rest?.replace(/^apply for\s+/i, '')) ||
          'Unknown role',
        company: clean(site?.replace(/\s+careers?$/i, '')) || location.pathname.split('/')[1] || 'Unknown',
        location: place || undefined,
        // The apply page carries no description; empty keeps the stored one.
        descriptionText: clean(document.querySelector('.jv-job-detail-description')?.textContent).slice(0, 30000),
      };
    });
  },

  async settle(page) {
    await settle(page);
  },

  async afterWall(page) {
    await settle(page);
    await acceptConsent(page).catch(() => false);
  },

  async extractForm(page) {
    const fields = await extractFields(page);
    const files = await markFileInputs(page);
    const fileFields: FormField[] = files.map((place) => ({
      id: `jobvite-${place}`,
      selector: `[${FILE_ATTR}="${place}"]`,
      name: place,
      kind: 'FILE',
      widget: 'file',
      label: place === 'resume' ? 'Resume' : 'Cover Letter',
      required: place === 'resume',
      sensitive: false,
    }));
    return [...fileFields, ...fields.filter((f) => f.kind !== 'FILE')];
  },

  fileInputs(fields) {
    return {
      resume: fields.find((f) => f.id === 'jobvite-resume'),
      coverLetter: fields.find((f) => f.id === 'jobvite-cover_letter'),
    };
  },

  async submit(page) {
    const button = page.locator('button[type="submit"][aria-label="Send Application"]').first();
    const target = (await button.count())
      ? button
      : page.getByRole('button', { name: /send application|submit application/i }).first();
    if (!(await target.isVisible().catch(() => false))) {
      throw new Error('No "Send Application" button on the Jobvite form.');
    }
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click();
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  },

  notes: [
    'Opens the posting\'s /apply page and accepts the Data Consent step (privacy-notice acknowledgement) first.',
    'One-page form; the resume and cover letter go straight into Jobvite\'s hidden file inputs.',
    'No captcha seen on Nutanix\'s board.',
  ],
};
