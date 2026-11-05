import type { Locator, Page } from 'playwright';
import { normalizeLabel, type FormField } from '@ja/shared';
import { FillError, cssEscape, labelTextFor } from './common.js';

export async function fillRadioGroup(page: Page, field: FormField, want: string): Promise<void> {
  const target = normalizeLabel(want);
  const scope = page.locator(field.optionContainerSelector ?? field.selector);
  const radios = scope.locator('input[type="radio"]');
  const count = await radios.count();
  for (let i = 0; i < count; i++) {
    const radio = radios.nth(i);
    if (normalizeLabel(await labelTextFor(page, radio)) === target) {
      // Oracle's radios are 0x0 under a drawn label, where a forced check can
      // miss; fall back to the label and then a native click.
      await radio.check({ force: true, timeout: 2_500 }).catch(() => {});
      if (!(await radio.isChecked().catch(() => false))) await setCheckedCovered(page, radio, true);
      if (!(await radio.isChecked().catch(() => false))) {
        throw new FillError(`Could not select "${want}" under ${field.label}`, field);
      }
      return;
    }
  }
  throw new FillError(`No radio option "${want}" under ${field.label}`, field);
}

/**
 * A toggle group's buttons: Ashby's `aria-pressed` ones, Oracle's radio pills,
 * or SmartRecruiters' `spl-radio` elements.
 */
const GROUP_BUTTONS =
  ':scope > button[aria-pressed], :scope > li > button[role="radio"], :scope > spl-radio';
export const GROUP_PRESSED =
  ':scope > button[aria-pressed="true"], :scope > li > button[role="radio"][aria-checked="true"], :scope > spl-radio[aria-checked="true"]';

/** A toggle button's option text. `spl-radio` draws it in a shadow root, so its innerText is empty. */
export async function groupButtonText(button: Locator): Promise<string> {
  return (await button.getAttribute('label'))?.trim() || (await button.innerText());
}

/** Yes/no toggles: press the button whose text is the answer. */
export async function fillButtonGroup(page: Page, field: FormField, want: string): Promise<void> {
  const target = normalizeLabel(want);
  const buttons = page.locator(field.selector).first().locator(GROUP_BUTTONS);
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    if (normalizeLabel(await groupButtonText(button)) === target) {
      const on = (await button.getAttribute('aria-pressed')) === 'true' || (await button.getAttribute('aria-checked')) === 'true';
      if (!on) await button.click();
      return;
    }
  }
  throw new FillError(`No option "${want}" under ${field.label}`, field);
}

export async function fillCheckboxGroup(page: Page, field: FormField, wants: string[]): Promise<void> {
  const scope = page.locator(field.optionContainerSelector ?? field.selector);
  const boxes = scope.locator('input[type="checkbox"]');
  const count = await boxes.count();
  const targets = new Set(wants.map(normalizeLabel));
  const foundLabels = new Set<string>();
  
  for (let i = 0; i < count; i++) {
    const box = boxes.nth(i);
    const label = normalizeLabel(await labelTextFor(page, box));
    if (targets.has(label)) {
      await box.check({ force: true });
      foundLabels.add(label);
    } else {
      // Uncheck boxes that aren't in the requested set to ensure exact state
      await box.uncheck({ force: true }).catch(() => {});
    }
  }
  
  if (foundLabels.size !== targets.size) {
    const missing = [...targets].filter(t => !foundLabels.has(t));
    throw new FillError(
      `Missing options for ${field.label}: ${missing.join(', ')}`,
      field,
    );
  }
}

/**
 * Tick or clear a checkbox, including one hidden under its own label.
 *
 * Okta's (and many styled) forms draw a fake box in the <label> and leave the
 * real input underneath it. setChecked() waits for the input to be clickable,
 * which never happens, so every such box spent 30+ seconds timing out and was
 * then handed to you. Try the normal way briefly, then the label, then the
 * input itself, checking the tick after each.
 */
export async function setCheckedCovered(page: Page, el: Locator, on: boolean): Promise<void> {
  const holds = async () => (await el.isChecked().catch(() => !on)) === on;
  if (await holds()) return;
  try {
    await el.setChecked(on, { timeout: 2_500 });
    if (await holds()) return;
  } catch {
    // Covered or styled box; fall through.
  }
  const id = await el.getAttribute('id').catch(() => null);
  const byFor = id ? page.locator(`label[for="${cssEscape(id)}"]`) : null;
  const label = byFor && (await byFor.count()) ? byFor.first() : el.locator('xpath=ancestor::label[1]');
  if (await label.count()) {
    await label.first().click({ timeout: 2_500 }).catch(() => {});
    if (await holds()) return;
  }
  await el.setChecked(on, { force: true, timeout: 2_500 }).catch(() => {});
  if (await holds()) return;
  // Last resort: a native click on the input fires the events React listens to.
  await el.evaluate((node) => (node as HTMLInputElement).click()).catch(() => {});
}
