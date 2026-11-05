import type { Page } from 'playwright';
import type { FormField, FieldOption } from '@ja/shared';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';
import type { AtsAdapter, JobMeta } from '../types.js';

/**
 * Okta job boards (okta.com/company/careers).
 *
 * Okta uses a custom Drupal-based form with specific characteristics:
 * - Custom fieldset structure with ods-fieldset classes
 * - File inputs with AJAX upload buttons
 * - Radio buttons in nested fieldsets
 * - Custom required field markers
 * - Google reCAPTCHA integration
 * - Drupal form validation
 */
export const oktaAdapter: AtsAdapter = {
  id: 'okta',

  matches(url) {
    return /okta\.com\/company\/careers/.test(url);
  },

  async openApplicationForm(page, url) {
    await openApplicationForm(page, url, {
      formSelectors: ['.okta-careers-job-form', 'form[data-drupal-selector="okta-careers-job-form"]'],
      applyPatterns: [/apply/i, /submit application/i],
    });
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const title =
        clean(document.querySelector('h1')?.textContent) ||
        clean(document.title).replace(/^Job Application for /i, '');
      const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '';
      const m = /(?:Job Application for )?(.*?) at (.*)$/i.exec(og || document.title);
      const company =
        clean(document.querySelector('.company-name, [class*="company"]')?.textContent) ||
        clean(m?.[2]) ||
        'Okta';
      const body = document.querySelector('.Job__content, .job-description, main');
      return {
        title: clean(m?.[1]) || title || 'Unknown role',
        company: company.replace(/[-_]/g, ' '),
        location: clean(document.querySelector('.location, .job__location')?.textContent) || undefined,
        descriptionText: clean(body?.textContent).slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    // Okta forms may need special handling for their custom structure
    // First try standard extraction
    let fields = await extractFields(page, { harvestComboboxOptions: true });
    
    // If standard extraction didn't find enough fields, try Okta-specific selectors
    if (fields.length < 5) {
      fields = await extractOktaFields(page);
    }
    
    return fields.map(refineOktaField);
  },

  fileInputs(fields) {
    return {
      resume: fields.find((f) => 
        f.kind === 'FILE' && /resume|cv/i.test(f.label + f.selector)
      ),
      coverLetter: fields.find((f) => 
        f.kind === 'FILE' && /cover/i.test(f.label + f.selector)
      ),
    };
  },

  async submit(page) {
    // Okta uses a specific submit button selector
    const btn = page
      .locator('.okta-careers-job-form button[type="submit"], button[data-drupal-selector="edit-submit-button"]')
      .filter({ hasText: /submit application/i })
      .first();
    
    if (await btn.count()) {
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      return;
    }
    
    // Fallback to generic submit
    const byRole = page.getByRole('button', { name: /submit/i });
    if (await byRole.count()) {
      await byRole.first().click();
    }
  },

  async attachFile(page, field, filePath) {
    // Okta uses custom AJAX upload buttons that need to be clicked
    const selector = field.selector;
    
    // First, check if there's a format radio button selection (Upload PDF vs Paste)
    // Okta's form has radio buttons like: edit-resume-format-upload-pdf
    const fieldIdMatch = selector.match(/data-ja-field="([^"]+)"/);
    if (fieldIdMatch) {
      const fieldHandle = fieldIdMatch[1];
      const uploadRadio = page.locator(`input[name="${fieldHandle}_format"][value="upload_pdf"]`);
      if (await uploadRadio.count()) {
        await uploadRadio.check({ force: true });
        await page.waitForTimeout(500); // Wait for UI to update
      }
    }

    // Look for Okta's custom upload button (edit-resume-upload-button pattern)
    const uploadButton = page.locator('button[name$="_upload_button"]').first();
    
    if (await uploadButton.count()) {
      // Click the upload button to trigger file selection
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10_000 }),
          uploadButton.click(),
        ]);
        await fileChooser.setFiles(filePath);
        return;
      } catch {
        // If file chooser doesn't appear, fall through to direct input
      }
    }

    // Fallback to standard file input
    const input = page.locator(selector).first();
    await input.waitFor({ state: 'attached', timeout: 10_000 });
    await input.setInputFiles(filePath);
  },

  notes: [
    'Okta uses Drupal forms with custom fieldset structure (ods-fieldset classes).',
    'File uploads require clicking custom AJAX upload buttons.',
    'Radio buttons are nested in complex fieldset structures.',
    'Google reCAPTCHA is present - may require manual intervention.',
    'Custom required field markers use ods-label classes.',
  ],
};

/**
 * Okta-specific field extraction as a fallback for complex forms.
 * Targets Okta's custom Drupal form structure.
 */
async function extractOktaFields(page: Page): Promise<FormField[]> {
  const raw = await page.evaluate(() => {
    const results: any[] = [];
    let counter = 0;
    
    const visible = (el: Element): boolean => {
      const s = getComputedStyle(el as HTMLElement);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        return (el as HTMLInputElement).type === 'file';
      }
      return true;
    };

    const textOf = (el: Element | null): string =>
      (el?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s*\*\s*$/, '') // Remove required asterisks
        .replace(/\s*\(\s*required\s*\)\s*/gi, '') // Remove (required) text
        .trim();

    const labelFor = (el: HTMLElement): string => {
      const aria = el.getAttribute('aria-label');
      if (aria?.trim()) return aria.trim();
      
      const id = el.getAttribute('id');
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l) return textOf(l);
      }
      
      const wrapping = el.closest('label');
      if (wrapping) return textOf(wrapping);
      
      // Okta-specific: look for ods-label in parent fieldset
      const fieldset = el.closest('.ods-fieldset');
      if (fieldset) {
        const label = fieldset.querySelector('.ods-label');
        if (label) return textOf(label);
      }
      
      return el.getAttribute('placeholder')?.trim() ?? '';
    };

    const isRequired = (el: HTMLElement): boolean => {
      if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') return true;
      const fieldset = el.closest('.ods-fieldset');
      if (fieldset) {
        const label = fieldset.querySelector('.ods-label');
        if (label && /[*\u2731\uFF0A\u2020\u271A]/.test(label.textContent || '')) return true;
      }
      return false;
    };

    const mark = (el: Element): string => {
      const h = `f${counter++}`;
      el.setAttribute('data-ja-field', h);
      return h;
    };

    // Target Okta's specific form structure
    const form = document.querySelector('.okta-careers-job-form, form[data-drupal-selector="okta-careers-job-form"]');
    if (!form) return results;

    const controls = Array.from(
      form.querySelectorAll<HTMLElement>('input, select, textarea'),
    );

    for (const el of controls) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      const name = el.getAttribute('name') ?? '';
      const id = el.getAttribute('id') ?? '';

      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') continue;
      if (!visible(el) && type !== 'file') continue;

      let kind: any = 'TEXT';
      let widget = 'native';
      let options: any[] = [];

      if (type === 'radio' || type === 'checkbox') {
        const siblings = name
          ? Array.from(form.querySelectorAll<HTMLElement>(`input[type="${type}"][name="${CSS.escape(name)}"]`))
          : [el];

        if (type === 'checkbox' && siblings.length === 1) {
          kind = 'CHECKBOX';
        } else {
          kind = type === 'radio' ? 'RADIO' : 'CHECKBOX_GROUP';
          widget = type === 'radio' ? 'radio-group' : 'checkbox-group';
          options = siblings.map((s) => ({
            label: labelFor(s),
            value: s.getAttribute('value') ?? undefined,
          }));
        }
      } else if (tag === 'select') {
        const sel = el as unknown as HTMLSelectElement;
        kind = sel.multiple ? 'MULTISELECT' : 'SELECT';
        options = Array.from(sel.options)
          .filter((o) => o.value !== '' || o.textContent?.trim())
          .map((o) => ({ label: (o.textContent ?? '').trim(), value: o.value }))
          .filter((o) => o.value !== '' && !/^(select\.*|choose\.*|please select)/i.test(o.label));
      } else if (tag === 'textarea') {
        kind = 'TEXTAREA';
      } else if (type === 'file') {
        kind = 'FILE';
        widget = 'file';
      } else if (type === 'email') {
        kind = 'EMAIL';
      } else if (type === 'tel') {
        kind = 'PHONE';
      } else if (type === 'url') {
        kind = 'URL';
      } else if (type === 'number') {
        kind = 'NUMBER';
      } else if (type === 'date') {
        kind = 'DATE';
      }

      results.push({
        handle: mark(el),
        name: name || id || '',
        tag, type,
        kind,
        widget,
        label: labelFor(el),
        helpText: '',
        required: isRequired(el),
        options,
      });
    }

    return results;
  });

  // Convert raw results to FormField format
  return raw.map((r: any): FormField => ({
    id: r.handle,
    selector: `[data-ja-field="${r.handle}"]`,
    name: r.name || undefined,
    kind: r.kind,
    label: r.label,
    helpText: r.helpText || undefined,
    required: r.required,
    options: r.options.length ? r.options as FieldOption[] : undefined,
    widget: r.widget,
    canonicalKey: undefined,
    sensitive: false,
  }));
}

/**
 * Okta uses specific naming patterns for their form fields.
 * This function refines the extracted fields to match Okta's conventions.
 */
function refineOktaField(field: FormField): FormField {
  const idHint = field.label.toLowerCase();
  const selectorHint = field.selector.toLowerCase();
  
  // Map Okta's field patterns to canonical keys
  const known: Record<string, string> = {
    'first name': 'identity.first_name',
    'last name': 'identity.last_name',
    'email': 'contact.email',
    'phone': 'contact.phone',
    'linkedin profile': 'social.linkedin',
    'website': 'social.website',
    'are you legally authorized to work': 'eligibility.work_authorization',
    'will you now or in the future require visa sponsorship': 'eligibility.visa_sponsorship',
    'do you have any family members': 'disclosure.relationships',
    'do you have any outside business activity': 'disclosure.outside_activities',
    'have you been employed by okta': 'disclosure.previous_employment',
  };

  // Check for matches in label or selector
  for (const [pattern, key] of Object.entries(known)) {
    if (idHint.includes(pattern) || selectorHint.includes(pattern.replace(/\s+/g, '_'))) {
      return { 
        ...field, 
        canonicalKey: key,
        sensitive: key.startsWith('disclosure.') || key.startsWith('eligibility.')
      };
    }
  }

  // Handle Okta's custom question fields (question_XXXXXXX pattern)
  const questionMatch = selectorHint.match(/question_(\d+)/);
  if (questionMatch) {
    return {
      ...field,
      name: field.name || `question_${questionMatch[1]}`,
    };
  }

  return field;
}
