import type { Locator, Page } from 'playwright';
import { normalizeLabel, type FormField } from '@ja/shared';

export class FillError extends Error {
  constructor(
    message: string,
    readonly field: FormField,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = 'FillError';
  }
}

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
    case 'combobox-intl-tel':
      await fillNative(page, field, asOne(value, field));
      break;
    case 'file':
      throw new FillError('File fields must be filled with attachFile()', field, false);
    default:
      await fillNative(page, field, value);
  }
}

async function fillNative(page: Page, field: FormField, value: string | string[]): Promise<void> {
  const el = page.locator(field.selector).first();
  await el.waitFor({ state: 'attached', timeout: 10_000 });

  switch (field.kind) {
    case 'SELECT': {
      const want = asOne(value, field);
      // Try by visible label, then by option value; both are common.
      try {
        await el.selectOption({ label: want });
      } catch {
        const optionValue = field.options?.find(
          (o) => normalizeLabel(o.label) === normalizeLabel(want),
        )?.value;
        if (!optionValue) throw new FillError(`No option "${want}" on ${field.label}`, field);
        await el.selectOption(optionValue);
      }
      break;
    }
    case 'MULTISELECT': {
      const wants = Array.isArray(value) ? value : [value];
      await el.selectOption(wants.map((label) => ({ label })));
      break;
    }
    case 'CHECKBOX': {
      const on = /^(true|yes|1|on|checked)$/i.test(asOne(value, field));
      await el.setChecked(on);
      break;
    }
    default: {
      const text = asOne(value, field);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 5000 }).catch(() => {});
      await el.fill('');
      // type() rather than fill() so React's onChange fires per keystroke;
      // some forms only validate on keyup and stay in an error state otherwise.
      await el.type(text, { delay: 12 });
      await el.evaluate((node) => {
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('blur', { bubbles: true }));
      });
    }
  }
}

/**
 * react-select (Greenhouse's board, Ashby, many custom forms).
 * The visible control is a text input with role="combobox"; options render
 * into a menu that may be portalled to document.body, so they are located
 * globally by role rather than inside the field's container.
 */
async function fillReactSelect(page: Page, field: FormField, value: string | string[]): Promise<void> {
  const wants = Array.isArray(value) ? value : [value];
  const input = page.locator(field.selector).first();
  await input.waitFor({ state: 'attached', timeout: 10_000 });
  await input.scrollIntoViewIfNeeded().catch(() => {});

  for (const want of wants) {
    await input.click({ timeout: 8000 });
    // Typing narrows a long list (country pickers run to 240 entries) and also
    // opens the menu when a bare click did not.
    await input.fill('').catch(() => {});
    await input.type(want.slice(0, 40), { delay: 15 });

    const option = await waitForOption(page, field, want);
    if (!option) {
      // Some react-selects filter to nothing on a long string; retry on a
      // shorter prefix before giving up.
      await input.fill('').catch(() => {});
      await input.type(want.split(/[\s,(]/)[0] ?? want, { delay: 15 });
      const retry = await waitForOption(page, field, want);
      if (!retry) throw new FillError(`Could not find option "${want}" for ${field.label}`, field);
      await retry.click();
    } else {
      await option.click();
    }
    await page.waitForTimeout(120);
  }
  // Close the menu so it cannot swallow the next click.
  await page.keyboard.press('Escape').catch(() => {});
}

async function waitForOption(page: Page, field: FormField, want: string): Promise<Locator | null> {
  const container = field.optionContainerSelector
    ? page.locator(field.optionContainerSelector)
    : page;
  const options = container.locator('[role="option"], .select__option');
  try {
    await options.first().waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    return null;
  }
  const target = normalizeLabel(want);
  const count = await options.count();
  let fallback: Locator | null = null;
  for (let i = 0; i < count; i++) {
    const opt = options.nth(i);
    const text = normalizeLabel((await opt.innerText().catch(() => '')) ?? '');
    if (text === target) return opt;
    if (!fallback && text.includes(target)) fallback = opt;
  }
  return fallback;
}

async function fillRadioGroup(page: Page, field: FormField, want: string): Promise<void> {
  const target = normalizeLabel(want);
  const scope = page.locator(field.optionContainerSelector ?? field.selector);
  const radios = scope.locator('input[type="radio"]');
  const count = await radios.count();
  for (let i = 0; i < count; i++) {
    const radio = radios.nth(i);
    if (normalizeLabel(await labelTextFor(page, radio)) === target) {
      await radio.check({ force: true });
      return;
    }
  }
  throw new FillError(`No radio option "${want}" under ${field.label}`, field);
}

async function fillCheckboxGroup(page: Page, field: FormField, wants: string[]): Promise<void> {
  const scope = page.locator(field.optionContainerSelector ?? field.selector);
  const boxes = scope.locator('input[type="checkbox"]');
  const count = await boxes.count();
  const targets = new Set(wants.map(normalizeLabel));
  let hit = 0;
  for (let i = 0; i < count; i++) {
    const box = boxes.nth(i);
    const label = normalizeLabel(await labelTextFor(page, box));
    if (targets.has(label)) {
      await box.check({ force: true });
      hit++;
    }
  }
  if (hit !== targets.size) {
    throw new FillError(
      `Checked ${hit} of ${targets.size} options for ${field.label}`,
      field,
    );
  }
}

/** Resolve the human-visible text attached to an input. */
async function labelTextFor(page: Page, input: Locator): Promise<string> {
  const aria = await input.getAttribute('aria-label');
  if (aria) return aria;
  const id = await input.getAttribute('id');
  if (id) {
    const byFor = page.locator(`label[for="${cssEscape(id)}"]`);
    if (await byFor.count()) return (await byFor.first().innerText()).trim();
  }
  // Wrapping <label><input/> text </label>
  const wrapped = input.locator('xpath=ancestor::label[1]');
  if (await wrapped.count()) return (await wrapped.first().innerText()).trim();
  const sibling = input.locator('xpath=following-sibling::*[1]');
  if (await sibling.count()) return (await sibling.first().innerText().catch(() => '')).trim();
  return (await input.getAttribute('value')) ?? '';
}

export async function attachFile(page: Page, selector: string, filePath: string): Promise<void> {
  const input = page.locator(selector).first();
  await input.waitFor({ state: 'attached', timeout: 10_000 });
  // setInputFiles works on inputs hidden behind a styled "Attach" button,
  // which is how every modern ATS renders file upload.
  await input.setInputFiles(filePath);
}

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
      // The chosen value renders as text in the control, not as input.value.
      const shell = page
        .locator(field.selector)
        .first()
        .locator('xpath=ancestor::*[contains(@class,"select-shell") or contains(@class,"select__control")][1]');
      const text = normalizeLabel(await shell.first().innerText().catch(() => ''));
      const ok = wants.every((w) => text.includes(w));
      return { ok, actual: text };
    }
    if (field.widget === 'radio-group' || field.widget === 'checkbox-group') {
      const scope = page.locator(field.optionContainerSelector ?? field.selector);
      const checked = scope.locator('input:checked');
      const n = await checked.count();
      const labels: string[] = [];
      for (let i = 0; i < n; i++) labels.push(normalizeLabel(await labelTextFor(page, checked.nth(i))));
      return { ok: wants.every((w) => labels.includes(w)), actual: labels.join(', ') };
    }
    const el = page.locator(field.selector).first();
    const actual = normalizeLabel((await el.inputValue().catch(() => '')) || '');
    if (field.kind === 'SELECT') {
      const selectedText = normalizeLabel(
        await el.locator('option:checked').innerText().catch(() => ''),
      );
      return { ok: wants.every((w) => selectedText.includes(w) || actual.includes(w)), actual: selectedText || actual };
    }
    return { ok: wants.every((w) => actual.includes(w)), actual };
  } catch (err) {
    return { ok: false, actual: `verification failed: ${(err as Error).message}` };
  }
}

function asOne(value: string | string[], field: FormField): string {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new FillError(`${field.label} takes one value, got ${value.length}`, field);
    }
    return value[0]!;
  }
  return value;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
