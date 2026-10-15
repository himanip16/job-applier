import type { Page } from 'playwright';
import { matchCanonical, type FieldOption, type FormField } from '@ja/shared';
import { evaluatePage } from './evaluate.js';

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

  /**
   * querySelectorAll that also descends into open shadow roots, in reading
   * order. SmartRecruiters' application is built from `spl-*` web components
   * with every input inside a shadow root: a plain querySelectorAll found
   * nothing at all on it. Playwright's CSS engine pierces open shadow roots,
   * so the `[data-ja-field]` selectors handed back still resolve when filling.
   */
  const deepAll = (root: ParentNode, sel: string): HTMLElement[] => {
    const out: HTMLElement[] = [];
    const visit = (node: ParentNode) => {
      for (const el of Array.from(node.children)) {
        if (el.matches(sel)) out.push(el as HTMLElement);
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    visit(root);
    return out;
  };

  /** getElementById in the control's own tree: a shadow root's ids are not the document's. */
  const byId = (el: Element, id: string): HTMLElement | null =>
    (el.getRootNode() as Document | ShadowRoot).getElementById?.(id) ?? document.getElementById(id);

  // Clear any handles from a previous extraction on this page.
  deepAll(document, `[${ATTR}]`).forEach((n) => n.removeAttribute(ATTR));
  deepAll(document, '[data-ja-group]').forEach((n) => n.removeAttribute('data-ja-group'));

  const visible = (el: Element): boolean => {
    const s = getComputedStyle(el as HTMLElement);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    // File inputs are routinely 0x0 behind a styled button; they still count
    // - but only when something has deliberately styled them that way, not
    // when a whole ancestor section is collapsed (`display: none` on a wrapper
    // does not change this element's own computed `display`, so the check
    // above misses it; a zero-size box does not distinguish "styled input"
    // from "not rendered at all"). `checkVisibility`/`offsetParent` answer
    // the ancestor question directly. Getting this wrong is exactly how a
    // resume field inside a not-yet-revealed "Apply" section could be read as
    // present before it actually is.
    if (r.width === 0 && r.height === 0) {
      if ((el as HTMLInputElement).type !== 'file') return false;
      const he = el as HTMLElement;
      return typeof he.checkVisibility === 'function' ? he.checkVisibility() : he.offsetParent !== null;
    }
    return true;
  };

  /**
   * Of several <form> elements on one page, the one that most looks like a
   * job application - scored on its own visible fields, not the page's.
   * A resume upload is worth more than any number of text fields: it is the
   * one thing a newsletter or "talent community" sign-up essentially never
   * asks for, and a job application almost always does, even when optional.
   */
  const bestForm = (forms: HTMLFormElement[], isVisible: (el: Element) => boolean): HTMLFormElement => {
    const score = (form: HTMLFormElement): number => {
      const controls = Array.from(
        form.querySelectorAll<HTMLElement>('input, select, textarea'),
      ).filter(isVisible);
      const hasFile = controls.some((el) => (el.getAttribute('type') ?? '').toLowerCase() === 'file');
      return controls.length + (hasFile ? 1000 : 0);
    };
    return forms.reduce((best, next) => (score(next) > score(best) ? next : best));
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

  /**
   * What a caption can look like.
   *
   * `[class*="label"]` and not `.label`, because Lever's custom questions use
   * `class="application-label"` and have no <label>, no `for`, no id and no
   * placeholder - so `.label` matched nothing and every card question on every
   * Lever posting arrived with an empty label.
   */
  const CAPTION_SELECTOR = 'label, legend, [class*="label"]';

  const textOf = (el: Element | null): string =>
    (el?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(REQUIRED_MARK, '')
      .replace(LABEL_NOISE, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /**
   * The caption a person would read next to this control.
   *
   * `grouped` is set for one radio or checkbox out of a set. Those are usually
   * wrapped in a <label> of their own holding the *option* text, so the
   * ordinary implicit-label rule names the group after its first option -
   * Lever's "Years of Exp" came out as "Less than 2 yrs".
   */
  const labelFor = (el: HTMLElement, grouped = false): string => {
    // Workday's dropdown buttons append their placeholder and required flag to
    // the aria-label ("Phone Device Type Select One Required"); on application
    // questions that is the *whole* aria-label, and the question lives in a
    // <label for>. Morningstar's three screening questions all reached you as
    // "Select One Required". Strip the suffix and, if nothing is left, look
    // further.
    const rawAria = el.getAttribute('aria-label');
    const aria = rawAria?.replace(/\s*\bselect one\b(\s+required)?\s*$/i, '').trim() || null;
    const placeholderAria = !!rawAria?.trim() && !aria;
    // Rippling labels every dropdown "Search", "Select..." or "textbox" and
    // names the actual question ("Gender", "Location") via aria-labelledby.
    // Read aria-label first and those questions reached you as "Search".
    const genericAria =
      /^(search|select\W*|choose\W*|textbox|combobox|input)$/i.test(aria?.trim() ?? '') &&
      el.hasAttribute('aria-labelledby');
    if (aria?.trim() && !genericAria) {
      // Workday's date boxes are labelled just "Month" / "Year"; the fieldset
      // legend says which date ("From", "To (Actual or Expected)").
      if (/^(day|month|year)$/i.test(aria.trim())) {
        const legend = textOf(el.closest('fieldset')?.querySelector('legend') ?? null);
        if (legend) return `${legend} ${aria.trim()}`;
      }
      return aria.trim();
    }

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => textOf(byId(el, id)))
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    const id = el.getAttribute('id');
    if (id) {
      const l = (el.getRootNode() as Document | ShadowRoot).querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l) return textOf(l);
    }

    const wrapping = el.closest('label');
    if (wrapping && !grouped) return textOf(wrapping);

    // Walk up looking for the nearest caption in a field wrapper. Covers
    // Greenhouse (.field-wrapper), Workable (fieldset), Ashby (div + label)
    // and Lever, whose custom questions have no <label> anywhere near the
    // control - just a sibling <div class="application-label"> with no `for`,
    // no id and no placeholder to fall back on.
    //
    // `[class*="label"]` rather than `.label` for exactly that reason: the
    // class is `application-label`, which `.label` does not match, and every
    // Lever card question was arriving nameless as a result.
    let node: HTMLElement | null = grouped ? (wrapping ?? el).parentElement : el.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      for (const l of Array.from(node.querySelectorAll(CAPTION_SELECTOR))) {
        // A caption that contains the control is the control's own wrapper,
        // and for one radio of a set that is the option, not the question.
        if (l.contains(el)) continue;
        const text = textOf(l);
        if (text) return text;
      }
    }
    return el.getAttribute('placeholder')?.trim() ?? '';
  };

  /**
   * The caption for a checkbox that stands alone.
   *
   * Microsoft's acknowledgments ("By checking this you agree to the Microsoft
   * Data Privacy Notice", the candidate code of conduct, the qualifications
   * disclaimer) are each one checkbox with aria-label "Yes", inside a group
   * that points at the real question with aria-labelledby. Read on its own
   * label, every one of them came out as a required question called "Yes".
   */
  //
  // Okta's are the same idea without the ARIA: a box captioned "Yes" or
  // "Yes, I acknowledge" under a plain heading that holds the question. So a
  // bare answer also looks for the nearest heading before the box.
  const BARE_ANSWER =
    /^((yes|no|ok|okay|true)\b[,.!]?\s*)?((i\s+)?(agree|accept|acknowledge|confirm|understand|consent|certify|do|have read and (agree|understand|accept)))?[.!]?$/i;
  const loneCheckboxLabel = (el: HTMLElement): string => {
    const own = labelFor(el);
    if (own && !BARE_ANSWER.test(own)) return own;
    const group = el.parentElement?.closest<HTMLElement>('[aria-labelledby]');
    const named = group
      ? (group.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((id) => textOf(byId(el, id)))
          .filter(Boolean)
          .join(' ')
      : '';
    if (named) return named;
    const legend = textOf(el.closest('fieldset')?.querySelector('legend') ?? null);
    if (legend) return legend;
    // The heading just before the box, or before one of its wrappers - as
    // long as that wrapper holds this box and no other control.
    let node: HTMLElement | null = el.closest('label') ?? el;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (depth && node.querySelectorAll('input:not([type="hidden"]), select, textarea').length > 1) break;
      const before = questionBefore(node);
      const text = before ? textOf(before) : '';
      if (text && !BARE_ANSWER.test(text)) return text;
    }
    const wrapper = (el.closest('label') ?? el).parentElement;
    return (wrapper && captionAbove(wrapper, [el])) || own;
  };

  const helpFor = (el: HTMLElement): string => {
    const describedBy = el.getAttribute('aria-describedby');
    if (describedBy) {
      const parts = describedBy
        .split(/\s+/)
        .map((id) => textOf(byId(el, id)))
        // Workday points every prompt at its live "0 items selected" status.
        .filter((t) => t && !/error/i.test(t) && !/^\d+ items? selected\b/i.test(t));
      if (parts.length) return parts.join(' ');
    }
    const wrapper = el.closest('.field-wrapper, fieldset, .field, .form-group');
    const hint = wrapper?.querySelector('.description, .help-text, .hint, small');
    return hint ? textOf(hint) : '';
  };

  /**
   * The ARIA box around a set of options. Google's EEO race question puts
   * `role="checkbox"` on the box around all of its checkboxes, so that counts
   * too - but only when it holds several inputs, or every single consent
   * checkbox would be mistaken for a group.
   */
  const ariaGroupOf = (el: HTMLElement): HTMLElement | null => {
    const box = el.closest<HTMLElement>('[role="radiogroup"], [role="group"], [role="checkbox"]');
    if (!box) return null;
    if (box.getAttribute('role') !== 'checkbox' || box.querySelectorAll('input').length >= 2) return box;
    return box.parentElement ? ariaGroupOf(box.parentElement) : null;
  };

  // Validation wording only. "Please indicate your gender" is a question.
  const VALIDATION_TEXT =
    /^(the answer is required|this (field|question) is required|required|error\b.*|please (select|choose|pick|enter|fill( in| out)?|complete|provide|make)( (an?|one|at least one|this|the|a valid|your))? ?(option|options|selection|value|answer|response|choice|field|question)\.?)$/i;

  /** The plain-text question sitting just before an ARIA group, if any. */
  const questionBefore = (group: HTMLElement): HTMLElement | null => {
    // Step over a validation message ("The answer is required") that
    // Google renders between the question and its options.
    let prev = group.previousElementSibling as HTMLElement | null;
    for (let hops = 0; prev && hops < 2; hops++, prev = prev.previousElementSibling as HTMLElement | null) {
      if (prev.querySelector('input, select, textarea, button')) break;
      const text = textOf(prev);
      if (!text || VALIDATION_TEXT.test(text)) continue;
      return text.length <= 300 ? prev : null;
    }
    return null;
  };

  const isRequired = (el: HTMLElement): boolean => {
    if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') return true;
    // Google Careers marks the group, not each radio in it.
    if (el.closest('[role="radiogroup"][aria-required="true"], [role="group"][aria-required="true"]')) return true;
    // ...except the EEO race box, which carries no required flag at all. Its
    // question ends in `*` or carries a "required field" marker instead.
    const group = ariaGroupOf(el);
    const question = group && questionBefore(group);
    if (question) {
      if (/[*\u2731\uFF0A]\s*$/.test(question.textContent ?? '')) return true;
      if (question.querySelector('[aria-label*="required" i], [title*="required" i]')) return true;
      if (/\brequired field\b/i.test(question.textContent ?? '')) return true;
    }
    // A marker glyph in the label is the near-universal convention for forms
    // that do not set the attribute. Ashby draws its asterisk with CSS from a
    // `_required_xxxx` class on the question title, so there is no glyph in
    // the text at all - its consent radios and yes/no buttons were read as
    // optional and left blank.
    const wrapper = el.closest(
      '.field-wrapper, fieldset, .field, .form-group, [class*="fieldEntry"], [class*="field-entry"]',
    );
    const caption = wrapper?.querySelector('label, legend');
    if (/[*\u2731\uFF0A\u2020\u271A]/.test(caption?.textContent ?? '')) return true;
    return /(^|[\s_-])required([\s_-]|$)/i.test(caption?.getAttribute('class') ?? '');
  };

  const mark = (el: Element): string => {
    const h = `f${counter++}`;
    el.setAttribute(ATTR, h);
    return h;
  };

  const CAPTCHA_NAMES = /recaptcha|captcha|hcaptcha|cf-turnstile|honeypot/i;

  const forms = Array.from(document.querySelectorAll('form'));
  // One form, or none at all (Ashby renders bare React with no <form>
  // wrapper): every fillable control on the page is fair game. Two or more is
  // a different situation - a careers page can carry the real application
  // and something else entirely, also wrapped in its own <form>. A live run
  // against Roku's board filled a "Join our Talent Community" newsletter
  // sign-up under the candidate's name because this used to merge every
  // form's fields into one list; picking the single form that most looks
  // like a job application, instead of merging, is what keeps a newsletter
  // widget from ever entering the field list at all. Weighted heavily toward
  // a resume upload, because a newsletter sign-up essentially never has one.
  const roots: Element[] =
    forms.length <= 1
      ? forms.length
        ? forms
        : [document.body]
      : [bestForm(forms, visible)];

  const seenRadioGroups = new Set<string>();

  /** The question above a group of options, never one of the options. */
  const captionAbove = (container: HTMLElement, options: HTMLElement[] = []): string => {
    // A <label for> pointing at one of the options is that option's caption.
    const optionIds = new Set(options.map((o) => o.id).filter(Boolean));
    const legend = container.querySelector('legend');
    if (legend) {
      const text = textOf(legend);
      if (text) return text;
    }
    // An ARIA group that names itself, or whose question sits as plain text
    // in the element just before it - Google Careers' qualification
    // questions, which have no <label> or <legend> at all.
    const group = ariaGroupOf(container);
    if (group) {
      const labelledBy = group.getAttribute('aria-labelledby');
      const named = labelledBy
        ? labelledBy.split(/\s+/).map((id) => textOf(document.getElementById(id))).filter(Boolean).join(' ')
        : '';
      if (named) return named;
      const question = questionBefore(group);
      if (question) return textOf(question);
      const aria = group.getAttribute('aria-label')?.trim();
      if (aria && !/radio input$/i.test(aria)) return aria;
    }
    let node: HTMLElement | null = container.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      for (const l of Array.from(node.querySelectorAll(CAPTION_SELECTOR))) {
        if (container.contains(l) || l.contains(container)) continue;
        if (optionIds.has(l.getAttribute('for') ?? '')) continue;
        // Another group's option ("Yes" of the question above) is never this
        // group's question. Google Careers' questions all came out as "Yes".
        const target = l.getAttribute('for') ? document.getElementById(l.getAttribute('for')!) : null;
        if (target && /^(radio|checkbox)$/i.test(target.getAttribute('type') ?? '')) continue;
        const text = textOf(l);
        if (text) return text;
      }
    }
    return '';
  };

  for (const root of roots) {
    // ---- toggle-button groups ---------------------------------------------
    // Ashby's yes/no questions are two <button aria-pressed> and a hidden
    // checkbox; none of it is an input anyone can see, so the sweep below
    // never found them and they were submitted blank. A set of pressable
    // buttons under one parent is a single-choice question.
    const buttonGroups = new Set<HTMLElement>();
    root.querySelectorAll<HTMLElement>('button[aria-pressed]').forEach((b) => {
      const parent = b.parentElement;
      if (parent && visible(b) && parent.querySelectorAll(':scope > button[aria-pressed]').length >= 2) {
        buttonGroups.add(parent);
      }
    });
    for (const group of buttonGroups) {
      const buttons = Array.from(group.querySelectorAll<HTMLElement>(':scope > button[aria-pressed]'));
      const handle = mark(group);
      group.setAttribute('data-ja-group', handle);
      results.push({
        handle,
        name: group.querySelector('input')?.getAttribute('name') ?? '',
        tag: 'div', type: 'button-group',
        kind: 'RADIO',
        widget: 'button-group',
        label: captionAbove(group),
        helpText: '',
        required: isRequired(group),
        options: buttons.map((b) => ({ label: textOf(b) })).filter((o) => o.label),
        groupHandle: handle,
      });
    }

    // ---- Workday dropdown ---------------------------------------------------
    // "Phone Device Type": a <button aria-haspopup="listbox"> showing the
    // choice, with the real value in a text input beside it. Neither looks
    // like a select, so it was never asked and Workday refused the step.
    deepAll(root, 'button[aria-haspopup="listbox"]').forEach((b) => {
      if (!visible(b)) return;
      results.push({
        handle: mark(b),
        name: b.getAttribute('name') || b.getAttribute('id') || '',
        tag: 'button', type: 'button',
        kind: 'SELECT',
        widget: 'workday-dropdown',
        label: labelFor(b),
        helpText: helpFor(b),
        required: isRequired(b) || /\brequired\b/i.test(b.getAttribute('aria-label') ?? ''),
        // Read from Node by opening it, like react-select.
        options: [],
      });
    });

    const controls = deepAll(root, 'input, select, textarea');

    for (const el of controls) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      const name = el.getAttribute('name') ?? '';
      const id = el.getAttribute('id') ?? '';

      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') continue;

      // ---- select2 (Amazon's applicant forms, jQuery-era boards) ----------
      // The real <select> is aria-hidden and clipped to 1px; the box a person
      // sees is a <span role="combobox"> drawn beside it. The span carries the
      // label and the required flag, the <select> carries the options - so
      // this is read before the aria-hidden skip below, which would drop it.
      if (tag === 'select' && el.classList.contains('select2-hidden-accessible')) {
        const box = el.nextElementSibling?.querySelector<HTMLElement>('[role="combobox"]');
        if (!box || !visible(box)) continue;
        const sel = el as unknown as HTMLSelectElement;
        const labelledBy = (box.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((ref) => document.getElementById(ref)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        results.push({
          handle: mark(el),
          name: el.getAttribute('name') || el.getAttribute('id') || '',
          tag, type,
          kind: sel.multiple ? 'MULTISELECT' : 'SELECT',
          widget: 'select2',
          label: labelledBy || labelFor(el),
          helpText: helpFor(el),
          required: box.getAttribute('aria-required') === 'true' || isRequired(el),
          options: Array.from(sel.options)
            .map((o) => ({ label: (o.textContent ?? '').trim(), value: o.value }))
            .filter((o) => o.value !== '' && o.label && !/^(select\.*|choose\.*|please select)/i.test(o.label)),
        });
        continue;
      }

      // react-select renders a second, aria-hidden input under each dropdown
      // purely for form validation. It is not a question; reading it asked
      // every Greenhouse dropdown twice, once as a text box.
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (CAPTCHA_NAMES.test(name) || CAPTCHA_NAMES.test(id)) continue;
      if (!visible(el) && type !== 'file') continue;
      // The value-holder beside a Workday dropdown; the button is the question.
      if (el.previousElementSibling?.matches('button[aria-haspopup="listbox"]')) continue;

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
            label: loneCheckboxLabel(el),
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

        // The question, not one of its answers.
        //
        // Reading a caption from inside the options container finds the first
        // option's own <label>, which is how Lever's "Years of Exp" came out
        // named "Less than 2 yrs". A <legend> is the one caption that lives
        // inside the group and still describes it; everything else has to come
        // from above the container.
        const legend = container.querySelector('legend');
        const groupLabel =
          (legend && !legend.contains(el) ? textOf(legend) : '') ||
          captionAbove(container, siblings) ||
          labelFor(el, true);

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

      // ---- Workday prompt ---------------------------------------------------
      // "How Did You Hear About Us?", "Country Phone Code": a plain text box
      // (no role, no aria-haspopup) that searches, with the choice shown as a
      // pill beside it. Read as a text box, it was typed into and left at
      // "0 items selected", and Workday refused the step. Options are not
      // harvested: many are trees ("Job Board" > "LinkedIn"), and the top
      // level would limit the answer to a category, which is not selectable.
      if (el.getAttribute('data-uxi-widget-type') === 'selectinput') {
        results.push({
          handle: mark(el),
          name: el.getAttribute('name') || el.getAttribute('id') || '',
          tag, type,
          kind: 'SELECT',
          widget: 'workday-prompt',
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

  // Button groups are swept first; put everything back in the order a person
  // reads the form, which is the order it is filled and reviewed in. Ranked
  // by a deep walk rather than compareDocumentPosition, which cannot order
  // elements in different shadow trees.
  const rank = new Map(deepAll(document, `[${ATTR}]`).map((el, i) => [el.getAttribute(ATTR), i]));
  results.sort((a, b) => (rank.get(a.handle) ?? 0) - (rank.get(b.handle) ?? 0));
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
  const raw = (await evaluatePage(page, EXTRACTOR)) as RawField[];
  const fields: FormField[] = [];

  for (const r of raw) {
    if (!r.label.trim()) continue;

    let options = r.options;
    if (
      (r.widget === 'react-select' || r.widget === 'workday-dropdown') &&
      (opts.harvestComboboxOptions ?? true)
    ) {
      options = await harvestOptions(page, `[data-ja-field="${r.handle}"]`, opts.maxOptions ?? 400);
      // Workday lists its own placeholder as the first option.
      options = options.filter((o) => !/^(select one|select\.*|choose\.*)$/i.test(o.label));
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
    await input.scrollIntoViewIfNeeded({ timeout: 2000 });
    await input.click({ timeout: 3000 });
    // A click focuses Greenhouse's dropdowns without opening them; ArrowDown does.
    if ((await input.getAttribute('aria-expanded')) !== 'true') await input.press('ArrowDown');

    // Only this dropdown's own menu. Reading every [role=option] on the page
    // picked up the phone field's always-rendered, hidden country list first,
    // waited for it to become visible, timed out - and the question reached
    // you as a text box with no choices.
    const controls = await input.getAttribute('aria-controls');
    const scoped = controls
      ? page.locator(`[id="${controls}"] [role="option"]`)
      : input
          .locator('xpath=ancestor::*[contains(@class,"select-shell") or contains(@class,"select__container")][1]')
          .locator('[role="option"], .select__option');
    const options = (await scoped.count()) ? scoped : page.locator('[role="option"]:visible, .select__option:visible');
    await options.first().waitFor({ state: 'visible', timeout: 2000 });
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
