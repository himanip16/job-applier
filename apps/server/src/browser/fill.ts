import type { Page } from 'playwright';
import { normalizeLabel, type FormField } from '@ja/shared';
import { FIELD_TIMEOUT_MS, FillError, asOne } from './fill/common.js';
import { fillReactSelect, fillSelect2 } from './fill/dropdowns.js';
import { fillButtonGroup, fillCheckboxGroup, fillRadioGroup, setCheckedCovered } from './fill/groups.js';
import { bestOption } from './fill/options.js';
import { fillWorkdayDropdown, fillWorkdayPrompt, fillWorkdayPromptMany } from './fill/workday.js';

// The drivers live in ./fill/: options (matching and finding list items),
// dropdowns, workday, groups (radios, toggles, checkboxes), upload, and
// readback (verifyFilled / readShown). This file routes a field to its driver.
export { FillError } from './fill/common.js';
export { openUi5ValueHelp } from './fill/dropdowns.js';
export { bestOption, controlledListId, optionText, slottedOptionRoot } from './fill/options.js';
export { readShown, verifyFilled } from './fill/readback.js';
export { attachFile, fileBoxShowsFile } from './fill/upload.js';
export { workdayPlain } from './fill/workday.js';

/**
 * Drive one control to a value, whatever it is made of.
 *
 * Real application forms are not `<input>` and `<select>`. Greenhouse renders
 * every dropdown as a react-select combobox - a text input plus a portalled
 * listbox - so `selectOption` throws on it. Lever uses genuine `<select>`.
 * Workable and Ashby mix both, plus custom radio cards. Each widget therefore
 * gets its own driver, and `verifyFilled` reads the value back afterwards so a
 * silently-ignored fill is caught here rather than discovered after submit.
 */
export async function fillField(page: Page, field: FormField, value: string | string[]): Promise<void> {
  // Check field state before attempting to fill
  const state = await inspectControl(page, field);
  
  // If field is locked and already holds the right value, skip filling
  if (state.locked && state.exists) {
    const wanted = Array.isArray(value) ? value.join(', ') : value;
    if (alreadyHolds(state.current, wanted)) {
      return; // Field is already correctly filled and locked
    }
    // Field is locked but has wrong value - this will be caught by verification
  }
  
  // If field doesn't exist in DOM, we can't fill it
  if (!state.exists) {
    throw new FillError(`Field "${field.label}" not found in DOM`, field, true);
  }

  switch (field.widget) {
    case 'react-select':
      await fillReactSelect(page, field, value);
      break;
    case 'radio-group':
      await fillRadioGroup(page, field, asOne(value, field));
      break;
    case 'checkbox-group':
      await fillCheckboxGroup(page, field, Array.isArray(value) ? value : [value]);
      break;
    case 'button-group':
      await fillButtonGroup(page, field, asOne(value, field));
      break;
    case 'workday-prompt':
      if (field.kind === 'MULTISELECT') await fillWorkdayPromptMany(page, field, Array.isArray(value) ? value : [value]);
      else await fillWorkdayPrompt(page, field, asOne(value, field));
      break;
    case 'workday-dropdown':
      await fillWorkdayDropdown(page, field, asOne(value, field));
      break;
    case 'combobox-intl-tel':
      await fillNative(page, field, asOne(value, field));
      break;
    case 'select2':
      await fillSelect2(page, field, asOne(value, field));
      break;
    case 'file':
      throw new FillError('File fields must be filled with attachFile()', field, false);
    default:
      await fillNative(page, field, value);
  }
}

/**
 * What state is this control actually in, before we try to drive it?
 *
 * Several applicant tracking systems parse the resume up front, fill the
 * identity fields from it, and then **disable** them so the parse cannot be
 * contradicted. Playwright's `fill` has no way to know that is deliberate: it
 * waits for the element to become editable, retries for the full timeout, and
 * eventually reports a failure on a field that was already correct. A live run
 * against Roku's board spent sixty seconds doing that to First Name, Last Name
 * and Email in turn, and then reported all three as errors.
 *
 * One cheap read tells us to leave them alone.
 */
export interface ControlState {
  /** The site will not let anyone change this. */
  locked: boolean;
  /** What it currently holds, as the page reports it. */
  current: string;
  exists: boolean;
}

export async function inspectControl(page: Page, field: FormField): Promise<ControlState> {
  try {
    const el = page.locator(field.selector).first();
    await el.waitFor({ state: 'attached', timeout: 2_000 });
    return await el.evaluate((node) => {
      const input = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const readOnly = 'readOnly' in input ? Boolean(input.readOnly) : false;
      return {
        locked: Boolean(input.disabled) || readOnly || input.getAttribute('aria-disabled') === 'true',
        current: 'value' in input ? String(input.value ?? '') : (node.textContent ?? '').trim(),
        exists: true,
      };
    });
  } catch {
    return { locked: false, current: '', exists: false };
  }
}

/**
 * Is the value already there, allowing for the site having masked it?
 *
 * Roku's board renders the parsed email as `h**********8@gmail.com`. That is
 * the right address with its middle hidden, and comparing it literally against
 * the profile says the field is wrong when it is exactly right - which would
 * send a perfectly good application to a human for no reason.
 */
export function alreadyHolds(current: string, wanted: string | string[]): boolean {
  const want = Array.isArray(wanted) ? wanted.join(', ') : wanted;
  const a = normalizeLabel(current);
  const b = normalizeLabel(want);
  if (!a || !b) return false;
  if (a === b) return true;

  const masked = current.match(/^(.*?)\*+(.*)$/);
  if (masked) {
    const head = normalizeLabel(masked[1] ?? '');
    const tail = normalizeLabel(masked[2] ?? '');
    // Both ends have to agree, and there has to be something to agree on -
    // otherwise "****" matches everything.
    if ((head || tail) && b.startsWith(head) && b.endsWith(tail)) return true;
  }
  return false;
}

async function fillNative(page: Page, field: FormField, value: string | string[]): Promise<void> {
  const el = page.locator(field.selector).first();
  await el.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });

  const disabled = await el.isDisabled().catch(() => false);
  if (disabled) return;

  const wants = (Array.isArray(value) ? value : [value]).map(normalizeLabel).filter(Boolean);
  // A checkbox's value is fixed by the site, ticked or not: Eightfold's
  // privacy box (Millennium) is value="Yes", which read as already answered
  // "yes", so it was never clicked. CHECKBOX checks its tick itself below.
  if (wants.length && field.kind !== 'CHECKBOX') {
    const current = normalizeLabel((await el.inputValue().catch(() => '')) ?? '');
    // A phone number counts as there only when the digits are the same.
    // Workday's resume parse leaves "+91-7029294010" in Phone Number beside
    // its own Country Phone Code; that holds "7029294010", so it was kept, and
    // Broadridge refused the step twice: "The number isn't recognized".
    const phone = field.kind === 'PHONE' || wants.every((w) => /^[\d\s()+.-]{6,}$/.test(w));
    const digits = (v: string) => v.replace(/\D/g, '');
    const holds = (want: string) => (phone ? digits(current) === digits(want) : current.includes(want));
    if (current && wants.every(holds)) return;
  }

  switch (field.kind) {
    case 'SELECT': {
      const want = asOne(value, field);
      // Try by visible label, then by the best option we can find; both are
      // common, and an exact label match is rarer than it looks.
      //
      // Short timeout on the speculative attempt. It is expected to miss - the
      // fallback below is the one that handles "India" against "India +91" -
      // and letting it wait out the default put 30 seconds on the clock for
      // every such field.
      try {
        await el.selectOption({ label: want }, { timeout: 3_000 });
      } catch {
        const option = bestOption(field.options, want);
        if (!option) throw new FillError(`No option "${want}" on ${field.label}`, field);
        await el.selectOption(option.value);
      }
      break;
    }
    case 'MULTISELECT': {
      const wants = Array.isArray(value) ? value : [value];
      const valuesToSelect: string[] = [];
      for (const want of wants) {
        const option = bestOption(field.options, want);
        if (!option) throw new FillError(`No option "${want}" on ${field.label}`, field);
        valuesToSelect.push(option.value);
      }
      await el.selectOption(valuesToSelect);
      break;
    }
    case 'CHECKBOX': {
      const on = /^(true|yes|1|on|checked)$/i.test(asOne(value, field));
      await setCheckedCovered(page, el, on);
      break;
    }
    default: {
      const text = asOne(value, field);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      // A native date picker takes keystrokes per segment in the browser's
      // locale order; typing "1998-08-15" into Juspay's DD/MM/YYYY box left it
      // empty. fill() with the ISO form sets it directly.
      if ((await el.getAttribute('type').catch(() => null)) === 'date') {
        const iso = isoDate(text);
        if (!iso) throw new FillError(`"${text}" is not a date for ${field.label}`, field);
        await el.fill(iso);
        await el.dispatchEvent('change').catch(() => {});
        break;
      }
      await el.fill('');
      // type() rather than fill() so React's onChange fires per keystroke;
      // some forms only validate on keyup and stay in an error state otherwise.
      await el.type(text, { delay: 12 });
      // Press Tab to trigger proper blur behavior instead of synthetic events
      await el.press('Tab').catch(() => {});
    }
  }
}

/**
 * YYYY-MM-DD for a native date input. Slashed or dashed numbers are read day
 * first, the order the forms that ask for them print in their placeholder.
 */
export function isoDate(text: string): string | null {
  const t = text.trim();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ok = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
      ? `${y}-${pad(m)}-${pad(d)}`
      : null;
  };
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ok(+m[1]!, +m[2]!, +m[3]!);
  m = t.match(/^(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4})$/);
  if (m) return ok(+m[3]!, +m[2]!, +m[1]!);
  const parsed = Date.parse(`${t} UTC`);
  if (Number.isNaN(parsed)) return null;
  const d = new Date(parsed);
  return ok(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
