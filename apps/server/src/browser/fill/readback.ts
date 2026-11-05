import type { Locator, Page } from 'playwright';
import { normalizeLabel, type FormField } from '@ja/shared';
import { cssEscape, labelTextFor } from './common.js';
import { GROUP_PRESSED, groupButtonText } from './groups.js';
import { bestOption, showsChosenOption } from './options.js';
import { workdayChosen, workdayPlain, workdaySelection, workdayShows } from './workday.js';

/**
 * Read the value back. A fill that React discarded, or a dropdown that closed
 * without committing, looks identical to a successful one until you check.
 */
export async function verifyFilled(
  page: Page,
  field: FormField,
  expected: string | string[],
): Promise<{ ok: boolean; actual: string }> {
  const wants = (Array.isArray(expected) ? expected : [expected]).map(normalizeLabel).filter(Boolean);
  if (!wants.length) return { ok: true, actual: '' };

  try {
    if (field.widget === 'react-select') {
      // SuccessFactors and Lever's location show the choice as the box's own
      // value and submit a hidden id beside it. Words typed but never picked
      // fill the box and leave the id empty, so both have to agree. Lever
      // shows "Patna, Bihar, IND" for "Patna, Bihar, India", so the shown
      // text is matched the way an option would be.
      const sf = await sfPicklistState(page, field);
      if (sf) {
        const shown = normalizeLabel(sf.shown);
        const ok =
          sf.picked &&
          wants.every(
            (w) => shown === normalizeLabel(w) || showsChosenOption(field, w, shown) || !!bestOption([{ label: sf.shown }], w),
          );
        return { ok, actual: sf.picked ? sf.shown : '' };
      }
      // The chosen value renders as text in the control, not as input.value.
      const shell = page
        .locator(field.selector)
        .first()
        .locator('xpath=ancestor::*[contains(@class,"select-shell") or contains(@class,"select__control")][1]');
      // Counted first: reading a shell that is not there waits out the 20s default.
      let text = (await shell.count())
        ? normalizeLabel(await shell.first().innerText().catch(() => ''))
        : '';
      // Microsoft's (Eightfold) dropdowns have neither class: the shell was
      // never found, every chosen value read as "", and correct answers were
      // reported as not holding. Fall back to the nearest box around this one
      // control that shows any text.
      if (!text) text = normalizeLabel(await shownAroundControl(page, field));
      // A phone country picker shows "+91" for "India +91" once chosen.
      const ok = wants.every((w) => text.includes(w) || showsChosenOption(field, w, text));
      return { ok, actual: text };
    }
    if (field.widget === 'workday-prompt') {
      const shown = await workdaySelection(page, field);
      // The chosen items, not the screen reader's status around them: an empty
      // box reads "0 items selected", and after a pause for you that was kept
      // as your answer to Field of Study and Skills, which were then left empty.
      return { ok: wants.every((w) => workdayShows(workdayPlain(w) || w, shown)), actual: workdayPlain(shown) };
    }
    if (field.widget === 'workday-dropdown') {
      const shown = normalizeLabel(await page.locator(field.selector).first().innerText().catch(() => ''));
      return { ok: wants.every((w) => shown === w || showsChosenOption(field, w, shown)), actual: shown };
    }
    if (field.widget === 'button-group') {
      const pressed = page.locator(field.selector).first().locator(GROUP_PRESSED);
      const labels: string[] = [];
      for (let i = 0; i < (await pressed.count()); i++) labels.push(normalizeLabel(await groupButtonText(pressed.nth(i))));
      return { ok: wants.every((w) => labels.includes(w)), actual: labels.join(', ') };
    }
    if (field.widget === 'radio-group' || field.widget === 'checkbox-group') {
      const scope = page.locator(field.optionContainerSelector ?? field.selector);
      const checked = scope.locator('input:checked');
      const n = await checked.count();
      const labels: string[] = [];
      for (let i = 0; i < n; i++) labels.push(normalizeLabel(await labelTextFor(page, checked.nth(i))));
      return { ok: wants.every((w) => labels.includes(w)), actual: labels.join(', ') };
    }
    let el = page.locator(field.selector).first();
    // Workday replaces a text input with a new node on blur, and our stamp
    // leaves with the old one. The name attribute survives the swap.
    if (!(await el.count()) && field.name) el = await byNameInRow(page, field);
    if (field.kind === 'CHECKBOX') {
      // The input's value is whatever the site set ("1", "on"); what matters is the tick.
      const want = /^(true|yes|1|on|checked)$/i.test(wants[0] ?? '');
      const checked = await el.isChecked().catch(() => false);
      return { ok: checked === want, actual: checked ? 'ticked' : 'not ticked' };
    }
    const actual = normalizeLabel((await el.inputValue({ timeout: 3_000 }).catch(() => '')) || '');
    if (field.kind === 'PHONE' || wants.every((w) => /^[\d\s()+.-]{6,}$/.test(w))) {
      // Sites reformat numbers as you type: "9902583674" becomes "99025 83674".
      const digits = (v: string) => v.replace(/\D/g, '');
      return { ok: wants.every((w) => digits(actual).endsWith(digits(w))), actual };
    }
    if (field.kind === 'SELECT') {
      const selectedText = normalizeLabel(
        await el.locator('option:checked').innerText().catch(() => ''),
      );
      const shown = selectedText || actual;
      const ok =
        wants.every((w) => selectedText.includes(w) || actual.includes(w)) ||
        wants.every((w) => showsChosenOption(field, w, shown));
      return { ok, actual: shown };
    }
    // Workday's month box shows "2" once "02" is typed into it.
    if (/^\d{1,4}$/.test(actual) && wants.every((w) => /^\d{1,4}$/.test(w))) {
      return { ok: wants.every((w) => Number(w) === Number(actual)), actual };
    }
    return { ok: wants.every((w) => actual.includes(w)), actual };
  } catch (err) {
    return { ok: false, actual: `verification failed: ${(err as Error).message}` };
  }
}

/**
 * What a control shows right now, as a person would read it: not normalised,
 * so a typed answer keeps its own capitals. Option controls report the
 * matching option labels. [] when blank, null when the control is not on the
 * page (moved on, re-rendered away) - which is not the same as cleared.
 */
export async function readShown(page: Page, field: FormField): Promise<string[] | null> {
  const asOptions = (shown: string[]): string[] =>
    shown
      .map((s) => s.trim())
      .filter((s) => s && !/^(select\b|0 items? selected|choose\b|--)/i.test(s))
      .map((s) => field.options?.find((o) => normalizeLabel(o.label) === normalizeLabel(s))?.label ?? s);
  const fromText = (text: string): string[] => {
    const norm = normalizeLabel(text);
    if (!norm) return [];
    if (!field.options?.length) return asOptions([text]);
    const exact = field.options.find((o) => normalizeLabel(o.label) === norm);
    if (exact) return [exact.label];
    // Several picks drawn side by side; anything unrecognised is not trusted.
    const within = field.options.filter((o) => norm.includes(normalizeLabel(o.label)) && normalizeLabel(o.label));
    return field.kind === 'MULTISELECT' || field.kind === 'CHECKBOX_GROUP' ? within.map((o) => o.label) : [];
  };

  try {
    if (field.widget === 'radio-group' || field.widget === 'checkbox-group') {
      const scope = page.locator(field.optionContainerSelector ?? field.selector);
      if (!(await scope.count())) return null;
      const checked = scope.locator('input:checked');
      const labels: string[] = [];
      for (let i = 0; i < (await checked.count()); i++) labels.push(await labelTextFor(page, checked.nth(i)));
      return asOptions(labels);
    }
    let el = page.locator(field.selector).first();
    if (!(await el.count()) && field.name) el = await byNameInRow(page, field);
    if (!(await el.count())) return null;
    if (field.widget === 'button-group') {
      const pressed = el.locator(GROUP_PRESSED);
      const labels: string[] = [];
      for (let i = 0; i < (await pressed.count()); i++) labels.push(await groupButtonText(pressed.nth(i)));
      return asOptions(labels);
    }
    if (field.widget === 'react-select') {
      const shell = el.locator('xpath=ancestor::*[contains(@class,"select-shell") or contains(@class,"select__control")][1]');
      const text = (await shell.count()) ? await shell.first().innerText().catch(() => '') : '';
      return fromText(text || (await shownAroundControl(page, field)));
    }
    if (field.widget === 'workday-prompt') {
      // The chosen items alone. The whole selection text carries the screen
      // reader's "expanded" and "1 item selected", and it went into the answer
      // bank as "1 item selected electronics electronics", which no list offers.
      const chosen = await workdayChosen(page, field);
      return chosen.length ? asOptions(chosen) : fromText(workdayPlain(await workdaySelection(page, field)));
    }
    if (field.widget === 'workday-dropdown') return fromText(await el.innerText().catch(() => ''));
    if (field.kind === 'CHECKBOX') return (await el.isChecked().catch(() => false)) ? ['Yes'] : [];
    if (field.kind === 'SELECT' && (await el.evaluate((n) => n.tagName === 'SELECT').catch(() => false))) {
      if (!(await el.inputValue().catch(() => ''))) return [];
      return asOptions([await el.locator('option:checked').innerText().catch(() => '')]);
    }
    const value = await el.inputValue({ timeout: 2_000 }).catch(() => '');
    return field.options?.length ? fromText(value) : value.trim() ? [value] : [];
  } catch {
    return null;
  }
}

/**
 * The control found by its name attribute, in this field's own row.
 *
 * Workday gives the inputs of every Employment row the same names, so the
 * first match is always row 1: on Walmart, rows 2-4 read back as "deliveroo"
 * and "software engineer 2" and were reported as not holding what was typed.
 */
async function byNameInRow(page: Page, field: FormField): Promise<Locator> {
  const all = page.locator(`[name="${cssEscape(field.name!)}"]`);
  const row = Number(/^(?:Employment|Education) (\d+):/.exec(field.label)?.[1] ?? 1);
  return row > 1 && (await all.count()) >= row ? all.nth(row - 1) : all.first();
}

/**
 * A SuccessFactors picklist's or Lever location's shown text, and whether its
 * hidden value is set.
 */
async function sfPicklistState(page: Page, field: FormField): Promise<{ shown: string; picked: boolean } | null> {
  return page
    .locator(field.selector)
    .first()
    .evaluate((el) => {
      // <input id="location-input"><input type="hidden" name="selectedLocation">
      // Lever empties both on blur unless a search result was picked.
      const lever = el.parentElement?.querySelector('input[type="hidden"][name="selectedLocation"]');
      if (lever instanceof HTMLInputElement) {
        return { shown: (el as HTMLInputElement).value.trim(), picked: Boolean(lever.value) };
      }
      const shell = el.closest('.sfCascadingPicklist')?.parentElement;
      if (!shell) return null;
      // <div id="picklist_country">...</div><input type="hidden" id="tor__fcountry">
      const holder = shell.nextElementSibling;
      const picked = holder instanceof HTMLInputElement && holder.type === 'hidden' ? Boolean(holder.value) : true;
      return { shown: (el as HTMLInputElement).value.trim(), picked };
    })
    .catch(() => null);
}

/** The text shown in the smallest box around one control, without the next question's. */
async function shownAroundControl(page: Page, field: FormField): Promise<string> {
  return page
    .locator(field.selector)
    .first()
    .evaluate((input) => {
      const own = (input as HTMLInputElement).value?.trim();
      // SmartRecruiters' multi-select shows each pick as an spl-tag in the
      // tags list's shadow root, its words in a `label` attribute.
      const tags = input.closest('spl-tags-list')?.shadowRoot?.querySelectorAll('spl-tag');
      if (tags?.length) {
        return Array.from(tags)
          .map((t) => t.getAttribute('label')?.trim() ?? '')
          .filter(Boolean)
          .join(', ');
      }
      // SmartRecruiters' spl-select draws its choice through slots the box's
      // innerText cannot see; the chosen option is the one named by its value.
      const splSelect = (input.getRootNode() as ShadowRoot).host;
      if (splSelect?.tagName === 'SPL-SELECT') {
        const value = splSelect.getAttribute('value') ?? '';
        const chosen = Array.from(splSelect.querySelectorAll('spl-select-option')).find(
          (o) => o.getAttribute('value') === value,
        );
        return ((chosen as HTMLElement | undefined)?.innerText ?? '').replace(/\s+/g, ' ').trim();
      }
      // Oracle's single-choice cx-select: the box around the input holds its
      // caption ("Country code"), the choice is the input's own value.
      if (input.closest('.cx-select-container')) return own ?? '';
      // SuccessFactors' UI5 pick-lists show the choice as the input's own
      // value; the box around it holds only screen-reader text.
      if (/^UI5-INPUT/.test(splSelect?.tagName ?? '')) return own ?? '';
      let node = input.parentElement;
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        // Stop before the box grows to take in another question.
        if (node.querySelectorAll('input:not([type="hidden"]), select, textarea').length > 1) break;
        const text = (node as HTMLElement).innerText?.replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      return own ?? '';
    })
    .catch(() => '');
}
