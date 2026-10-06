import type { Page } from 'playwright';
import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import type { FormField } from '@ja/shared';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';
import { MONTH_YEAR_HINT } from '../../engine/repeatableSections.js';

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
 *   - Experience and Education are empty until "Add" opens an editor
 *     (oc-experience-entry / oc-education-entry); several can be open at
 *     once, and each closes with its own Save. Its From/To are month-year
 *     pickers that parse a typed "10/2023" but read "Mar 2025" as 08/2027,
 *     and stay open over the "I currently work here" box below them. Each
 *     picker also holds a 0x0 "Year" number input that is not ours to fill.
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
    const hooks = await testHooks(page, fields.map((f) => f.id));
    const shaped = fields
      // The prefill drop zone rewrites the form from a parsed resume; leave it alone.
      .filter((f) => hooks[f.id]?.hook !== 'apply-with-resume-container')
      .filter((f) => !hooks[f.id]?.pickerInternal)
      .map((f): FormField => {
        const at = hooks[f.id];
        if (at?.hook === 'resume-upload') return { ...f, label: 'Resume' };
        if (/^(experience|education)-date-(from|to)$/.test(at?.hook ?? '')) {
          return { ...f, helpText: [f.helpText, MONTH_YEAR_HINT].filter(Boolean).join(' ') };
        }
        // Its aria-labelledby points at nothing; the words are on the host.
        if (/^(experience|education)-current$/.test(at?.hook ?? '') && at?.hostText) {
          return { ...f, label: at.hostText };
        }
        return f;
      });
    return currentBoxFirst(shaped, hooks);
  },

  fileInputs(fields) {
    return {
      resume: fields.find((f) => f.kind === 'FILE' && /resume|cv/i.test(fileHint(f))),
      coverLetter: fields.find((f) => f.kind === 'FILE' && /cover/i.test(fileHint(f))),
    };
  },

  async beforeAdvance(page) {
    await saveOpenEntries(page);
  },

  async submit(page) {
    await page.getByRole('button', { name: /submit( application)?|send application/i }).first().click();
  },

  notes: [
    'Every form control sits inside a shadow root (spl-* web components).',
    'The "apply with resume" prefill drop zone is skipped; the resume goes in the attachment drop zone.',
    'City is an autocomplete: check it picked a suggestion before submitting.',
    'Experience and education entries are added one editor per entry and saved before moving on.',
  ],
  alwaysReview: true,
};

interface Hook {
  /** The nearest form-level `data-test` around the field, through shadow hosts. */
  hook: string;
  /** Which editor it belongs to, e.g. "oc-experience-entry#1". */
  entry: string | null;
  /** The text of the component wrapping the input, for controls with no label. */
  hostText: string;
  /** The picker's own hidden year box, not a field of the form. */
  pickerInternal: boolean;
}

/** Where each extracted field sits in SmartRecruiters' component tree. */
async function testHooks(page: Page, handles: string[]): Promise<Record<string, Hook>> {
  return page.evaluate((wanted) => {
    const out: Record<string, Hook> = {};
    const up = (el: Element): Element | null =>
      el.parentElement ?? ((el.getRootNode() as ShadowRoot).host || null);
    const visit = (root: ParentNode) => {
      for (const el of Array.from(root.children)) {
        const h = el.getAttribute('data-ja-field');
        if (h && wanted.includes(h)) {
          let hook = '';
          let entry: string | null = null;
          let pickerInternal = false;
          for (let e = up(el); e; e = up(e)) {
            // `spl-*` hooks are the components' own internals, not the form's.
            const test = e.getAttribute('data-test') ?? '';
            if (!hook && test && !test.startsWith('spl-')) hook = test;
            if (e.tagName === 'SPL-DATE-PICKER' && el.matches('input[type="number"]')) pickerInternal = true;
            if (!entry && /^OC-(EXPERIENCE|EDUCATION)-ENTRY$/.test(e.tagName)) {
              const tag = e.tagName.toLowerCase();
              entry = `${tag}#${Array.from(document.querySelectorAll(tag)).indexOf(e)}`;
            }
          }
          const host = (el.getRootNode() as ShadowRoot).host;
          const hostText = (host?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
          out[h] = { hook, entry, hostText, pickerInternal };
        }
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(document);
    return out;
  }, handles);
}

/**
 * Put each editor's "I currently work here" box ahead of its dates. Typing a
 * date leaves its picker open over the box, and a click on the box then lands
 * on the picker instead.
 */
function currentBoxFirst(fields: FormField[], hooks: Record<string, Hook>): FormField[] {
  const out = [...fields];
  for (const box of fields.filter((f) => /-current$/.test(hooks[f.id]?.hook ?? ''))) {
    const entry = hooks[box.id]?.entry;
    const firstDate = out.findIndex(
      (f) => hooks[f.id]?.entry === entry && /-date-(from|to)$/.test(hooks[f.id]?.hook ?? ''),
    );
    const at = out.indexOf(box);
    if (!entry || firstDate < 0 || firstDate > at) continue;
    out.splice(at, 1);
    out.splice(firstDate, 0, box);
  }
  return out;
}

/**
 * Press Save on every open Experience/Education editor. An editor left open
 * is not part of the application. One that will not save (a required title
 * left blank) stays open, and the step's Next then reports why.
 */
async function saveOpenEntries(page: Page): Promise<void> {
  // A date picker left open can sit over the Save button.
  await page.keyboard.press('Escape').catch(() => {});
  const saves = page.locator(
    'oc-button[data-test="experience-save"] spl-button, oc-button[data-test="education-save"] spl-button',
  );
  for (let i = await saves.count(); i > 0; i--) {
    const save = saves.first();
    if (!(await save.isVisible().catch(() => false))) break;
    const before = await saves.count();
    await save.scrollIntoViewIfNeeded().catch(() => {});
    await save.click({ timeout: 5000 }).catch(() => {});
    // Saving closes the editor and removes its button; if it did not, the
    // editor refused, and pressing it again would not change that.
    const closed = await page
      .waitForFunction(
        (n) =>
          document.querySelectorAll(
            'oc-button[data-test="experience-save"], oc-button[data-test="education-save"]',
          ).length < n,
        before,
        { timeout: 5000 },
      )
      .then(() => true, () => false);
    if (!closed) break;
  }
}
