import type { Page } from 'playwright';
import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';

/**
 * SmartRecruiters (jobs.smartrecruiters.com/<Company>/<id>-<slug>).
 *
 * Seen on a live ServiceNow posting in October 2026:
 *   - the posting's apply control is a link reading "I'm interested", which
 *     navigates to /oneclick-ui/company/<Company>/publication/<uuid>
 *   - that form is Angular wrapping SmartRecruiters' own `spl-*` web
 *     components, and EVERY control lives in an open shadow root
 *     (spl-input > input#first-name-input, with its <label for> beside it in
 *     the same root). There are zero inputs in the light DOM.
 *   - there are two identical "Choose a file or drop it here" drop zones: the
 *     first (`data-test="apply-with-resume-container"`) parses a resume to
 *     prefill the form, the second (`data-test="resume-upload"`) is the
 *     resume actually attached to the application
 *   - City is an autocomplete; phone is a country select plus a tel input
 *   - the form ends in "Next", so the final step has not been seen
 */
export const smartRecruitersAdapter: AtsAdapter = {
  id: 'smartrecruiters',

  matches(url) {
    return /(?:jobs|careers)\.smartrecruiters\.com/.test(url);
  },

  async openApplicationForm(page, url) {
    await openApplicationForm(page, url, { applyPatterns: [/i[’']?m interested/i] });
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      // "Easy apply - Sr Software Engineer - ServiceNow" on the form,
      // "<Title> | <Company>"-ish elsewhere; the path always has the company.
      const titleParts = clean(document.title).split(' - ');
      const fromPath = location.pathname.match(/\/company\/([^/]+)/)?.[1] ?? location.pathname.split('/').filter(Boolean)[0];
      return {
        title: clean(document.querySelector('h1')?.textContent) || titleParts[1] || 'Unknown role',
        company:
          clean(document.querySelector('[itemprop="hiringOrganization"] [itemprop="name"]')?.getAttribute('content')) ||
          (titleParts.length >= 3 ? titleParts[titleParts.length - 1] : '') ||
          decodeURIComponent(fromPath ?? '') ||
          'Unknown',
        location: clean(document.querySelector('[itemprop="jobLocation"], .job-details li')?.textContent) || undefined,
        descriptionText: clean(document.querySelector('.job-sections, [itemprop="description"], main')?.textContent).slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    const fields = await extractFields(page, { harvestComboboxOptions: true });
    const zones = await fileZones(page, fields.filter((f) => f.kind === 'FILE').map((f) => f.id));
    return fields
      // The prefill drop zone rewrites the form from a parsed resume; leave it alone.
      .filter((f) => zones[f.id] !== 'apply-with-resume-container')
      .map((f) => (zones[f.id] === 'resume-upload' ? { ...f, label: 'Resume' } : f));
  },

  fileInputs(fields) {
    return {
      resume: fields.find((f) => f.kind === 'FILE' && /resume|cv/i.test(fileHint(f))),
      coverLetter: fields.find((f) => f.kind === 'FILE' && /cover/i.test(fileHint(f))),
    };
  },

  async submit(page) {
    await page.getByRole('button', { name: /submit( application)?|send application/i }).first().click();
  },

  notes: [
    'Every form control sits inside a shadow root (spl-* web components).',
    'The "apply with resume" prefill drop zone is skipped; the resume goes in the attachment drop zone.',
    'City is an autocomplete: check it picked a suggestion before submitting.',
  ],
  alwaysReview: true,
};

/** Which `data-test` drop zone each file field sits in, found through its shadow host. */
async function fileZones(page: Page, handles: string[]): Promise<Record<string, string>> {
  return page.evaluate((wanted) => {
    const out: Record<string, string> = {};
    const visit = (root: ParentNode) => {
      for (const el of Array.from(root.children)) {
        const h = el.getAttribute('data-ja-field');
        if (h && wanted.includes(h)) {
          let host = (el.getRootNode() as ShadowRoot).host as Element | undefined;
          while (host && !host.getAttribute('data-test')) host = (host.getRootNode() as ShadowRoot).host;
          if (host) out[h] = host.getAttribute('data-test') ?? '';
        }
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(document);
    return out;
  }, handles);
}
