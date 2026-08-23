import type { Page } from 'playwright';
import { matchCanonical, type FieldOption, type FormField } from '@ja/shared';

/**
 * Raw, DOM-level description of one control, produced inside the page.
 * Deliberately plain data - it has to survive being serialised out of the
 * browser context.
 */
interface RawField {
  handle: string;
  name?: string;
  tag: string;
  type: string;
  kind: FormField['kind'];
  widget: FormField['widget'];
  label: string;
  helpText: string;
  required: boolean;
  options: FieldOption[];
  /** Container to scope radio/checkbox group lookups to. */
  groupHandle?: string;
}

const EXTRACTOR = () => {
  const ATTR = 'data-ja-field';
  const results: RawField[] = [];
  let counter = 0;

  // Clear any handles from a previous extraction on this page.
  document.querySelectorAll(`[${ATTR}]`).forEach((n) => n.removeAttribute(ATTR));
  document.querySelectorAll('[data-ja-group]').forEach((n) => n.removeAttribute('data-ja-group'));

  const visible = (el: Element): boolean => {
    const s = getComputedStyle(el as HTMLElement);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    // File inputs are routinely 0x0 behind a styled button; they still count.
    if (r.width === 0 && r.height === 0) {
      return (el as HTMLInputElement).type === 'file';
    }
    return true;
  };

  // Required markers come in many glyphs: *, U+2731 heavy asterisk, fullwidth
  // star, dagger. All of them are decoration, none of them are part of the
  // question, and leaving them in poisons both display and label matching.
  const REQUIRED_MARK = /[*\u2731\uFF0A\u2020\u271A]+\s*$/;
  /**
   * Decoration that is not part of the question.
   *
   * A live Roku posting produced the label "First Name (required) d1a61ede" -
   * the word (required), which we already track as a boolean, and a per-render
   * uid the board stamps into the label element. Both make the review screen
   * ugly, and the uid is worse than that: it changes when the field
   * re-renders, so anything matching a field by its label stops finding it.
   */
  const LABEL_NOISE =
    /\s*(\(\s*(required|optional|mandatory)\s*\)|\b[0-9a-f]{8,}\b)\s*/gi;

  const textOf = (el: Element | null): string =>
    (el?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(REQUIRED_MARK, '')
      .replace(LABEL_NOISE, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const labelFor = (el: HTMLElement): string => {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    const id = el.getAttribute('id');
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l) return textOf(l);
    }

    const wrapping = el.closest('label');
    if (wrapping) return textOf(wrapping);

    // Walk up looking for the nearest label inside a field wrapper. Covers
    // Greenhouse (.field-wrapper), Workable (fieldset), Ashby (div + label).
    let node: HTMLElement | null = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const l = node.querySelector('label, legend, .label');
      if (l && !l.contains(el)) return textOf(l);
    }
    return el.getAttribute('placeholder')?.trim() ?? '';
  };

  const helpFor = (el: HTMLElement): string => {
    const describedBy = el.getAttribute('aria-describedby');
    if (describedBy) {
      const parts = describedBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter((t) => t && !/error/i.test(t));
      if (parts.length) return parts.join(' ');
    }
    const wrapper = el.closest('.field-wrapper, fieldset, .field, .form-group');
    const hint = wrapper?.querySelector('.description, .help-text, .hint, small');
    return hint ? textOf(hint) : '';
  };

  const isRequired = (el: HTMLElement): boolean => {
    if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') return true;
    // A marker glyph in the label is the near-universal convention for forms
    // that do not set the attribute.
    const wrapper = el.closest('.field-wrapper, fieldset, .field, .form-group');
    const labelText = wrapper?.querySelector('label, legend')?.textContent ?? '';
    return /[*\u2731\uFF0A\u2020\u271A]/.test(labelText);
  };

  const mark = (el: Element): string => {
    const h = `f${counter++}`;
    el.setAttribute(ATTR, h);
    return h;
  };

  const CAPTCHA_NAMES = /recaptcha|captcha|hcaptcha|cf-turnstile|honeypot/i;

  const forms = Array.from(document.querySelectorAll('form'));
  const roots: Element[] = forms.length ? forms : [document.body];

  const seenRadioGroups = new Set<string>();

  for (const root of roots) {
    const controls = Array.from(
      root.querySelectorAll<HTMLElement>('input, select, textarea'),
    );

    for (const el of controls) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      const name = el.getAttribute('name') ?? '';
      const id = el.getAttribute('id') ?? '';

      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') continue;
      if (CAPTCHA_NAMES.test(name) || CAPTCHA_NAMES.test(id)) continue;
      if (!visible(el) && type !== 'file') continue;

      // ---- radio / checkbox groups -------------------------------------
      if (type === 'radio' || type === 'checkbox') {
        const groupKey = name || labelFor(el);
        const siblings = name
          ? Array.from(root.querySelectorAll<HTMLElement>(`input[type="${type}"][name="${CSS.escape(name)}"]`))
          : [el];

        // A lone checkbox is a consent toggle, not a group.
        if (type === 'checkbox' && siblings.length === 1) {
          results.push({
            handle: mark(el),
            name: el.getAttribute('name') || el.getAttribute('id') || '',
            tag, type,
            kind: 'CHECKBOX',
            widget: 'native',
            label: labelFor(el),
            helpText: helpFor(el),
            required: isRequired(el),
            options: [],
          });
          continue;
        }

        if (seenRadioGroups.has(`${type}:${groupKey}`)) continue;
        seenRadioGroups.add(`${type}:${groupKey}`);

        // Scope the group to the closest ancestor that contains all members.
        let container: HTMLElement = el.parentElement ?? (root as HTMLElement);
        while (container.parentElement && !siblings.every((s) => container.contains(s))) {
          container = container.parentElement;
        }
        const groupHandle = `g${counter}`;
        container.setAttribute('data-ja-group', groupHandle);

        const groupLabel =
          textOf(container.querySelector('legend, label:not([for]), .label')) ||
          labelFor(el);

        results.push({
          handle: mark(el),
          name: el.getAttribute('name') || el.getAttribute('id') || '',
          tag, type,
          kind: type === 'radio' ? 'RADIO' : 'CHECKBOX_GROUP',
          widget: type === 'radio' ? 'radio-group' : 'checkbox-group',
          label: groupLabel,
          helpText: helpFor(el),
          required: isRequired(el),
          options: siblings.map((s) => ({
            label: labelFor(s),
            value: s.getAttribute('value') ?? undefined,
          })),
          groupHandle,
        });
        continue;
      }

      // ---- file ---------------------------------------------------------
      if (type === 'file') {
        results.push({
          handle: mark(el),
          name: el.getAttribute('name') || el.getAttribute('id') || '',
          tag, type,
          kind: 'FILE',
          widget: 'file',
          label: labelFor(el) || (id.includes('cover') ? 'Cover Letter' : 'Resume'),
          helpText: helpFor(el),
          required: isRequired(el),
          options: [],
        });
        continue;
      }

      // ---- native select --------------------------------------------------
      if (tag === 'select') {
        const sel = el as unknown as HTMLSelectElement;
        const opts = Array.from(sel.options)
          .filter((o) => o.value !== '' || o.textContent?.trim())
          .map((o) => ({ label: (o.textContent ?? '').trim(), value: o.value }))
          // Drop the leading "Select..." placeholder.
          .filter((o) => o.value !== '' && !/^(select\.*|choose\.*|please select)/i.test(o.label));
        results.push({
          handle: mark(el),
          name: el.getAttribute('name') || el.getAttribute('id') || '',
          tag, type,
          kind: sel.multiple ? 'MULTISELECT' : 'SELECT',
          widget: 'native',
          label: labelFor(el),
          helpText: helpFor(el),
          required: isRequired(el),
          options: opts,
        });
        continue;
      }

      // ---- textarea -------------------------------------------------------
      if (tag === 'textarea') {
        results.push({
          handle: mark(el),
          name: el.getAttribute('name') || el.getAttribute('id') || '',
          tag, type,
          kind: 'TEXTAREA',
          widget: 'native',
          label: labelFor(el),
          helpText: helpFor(el),
          required: isRequired(el),
          options: [],
        });
        continue;
      }

      // ---- combobox (react-select and friends) -----------------------------
      const role = el.getAttribute('role');
      if (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
        const multi = !!el.closest('.select__value-container--is-multi, [class*="is-multi"]');
        results.push({
          handle: mark(el),
          name: el.getAttribute('name') || el.getAttribute('id') || '',
          tag, type,
          kind: multi ? 'MULTISELECT' : 'SELECT',
          widget: 'react-select',
          label: labelFor(el),
          helpText: helpFor(el),
          required: isRequired(el),
          // Filled in from Node by opening the menu; the options do not exist
          // in the DOM until then.
          options: [],
        });
        continue;
      }

      // ---- plain inputs -----------------------------------------------------
      const kind: FormField['kind'] =
        type === 'email' ? 'EMAIL'
        : type === 'tel' ? 'PHONE'
        : type === 'url' ? 'URL'
        : type === 'number' ? 'NUMBER'
        : type === 'date' ? 'DATE'
        : 'TEXT';

      results.push({
        handle: mark(el),
        name: el.getAttribute('name') || el.getAttribute('id') || '',
        tag, type,
        kind,
        widget: 'native',
        label: labelFor(el),
        helpText: helpFor(el),
        required: isRequired(el),
        options: [],
      });
    }
  }

  return results;
};

/**
 * Read every fillable control off the live page.
 *
 * Two passes: a DOM sweep inside the browser, then a Node-side pass that opens
 * each combobox to harvest its options - react-select does not render its
 * listbox until it is focused, so there is no way to see the choices without
 * interacting with it.
 */
export async function extractFields(
  page: Page,
  opts: { harvestComboboxOptions?: boolean; maxOptions?: number } = {},
): Promise<FormField[]> {
  const raw = (await page.evaluate(EXTRACTOR)) as RawField[];
  const fields: FormField[] = [];

  for (const r of raw) {
    if (!r.label.trim()) continue;

    let options = r.options;
    if (
      r.widget === 'react-select' &&
      (opts.harvestComboboxOptions ?? true)
    ) {
      options = await harvestOptions(page, `[data-ja-field="${r.handle}"]`, opts.maxOptions ?? 400);
    }

    const canonical = matchCanonical(r.label);
    fields.push({
      id: r.handle,
      selector: `[data-ja-field="${r.handle}"]`,
      name: r.name || undefined,
      kind: r.kind,
      label: r.label,
      helpText: r.helpText || undefined,
      required: r.required,
      options: options.length ? options : undefined,
      widget: r.widget,
      optionContainerSelector: r.groupHandle ? `[data-ja-group="${r.groupHandle}"]` : undefined,
      canonicalKey: canonical?.key,
      sensitive: canonical?.sensitive ?? false,
    });
  }
  return fields;
}

/** Open a combobox, read its options, close it again. */
async function harvestOptions(page: Page, selector: string, max: number): Promise<FieldOption[]> {
  const input = page.locator(selector).first();
  try {
    await input.scrollIntoViewIfNeeded({ timeout: 3000 });
    await input.click({ timeout: 5000 });
    const options = page.locator('[role="option"], .select__option');
    await options.first().waitFor({ state: 'visible', timeout: 3000 });
    const count = Math.min(await options.count(), max);
    const out: FieldOption[] = [];
    for (let i = 0; i < count; i++) {
      const label = (await options.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (label) out.push({ label });
    }
    return out;
  } catch {
    return [];
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
  }
}
