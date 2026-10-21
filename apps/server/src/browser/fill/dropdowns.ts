import type { Locator, Page } from 'playwright';
import { normalizeLabel, type FormField } from '@ja/shared';
import { FIELD_TIMEOUT_MS, FillError, OPTION_TIMEOUT_MS } from './common.js';
import { bestOption, waitForOption } from './options.js';
import { verifyFilled } from './readback.js';

/**
 * select2 (Amazon's applicant forms): a hidden <select> with a drawn box
 * beside it and a results list appended to <body> when it opens.
 *
 * Picked through the drawn box, as a person would. Setting the hidden
 * <select> directly changes its value but not the page's own state - Amazon
 * listens for select2's events and kept saying "This field is required".
 * The jQuery route is only the fallback for a list that would not open.
 */
export async function fillSelect2(page: Page, field: FormField, want: string): Promise<void> {
  const option = bestOption(field.options, want);
  if (!option) throw new FillError(`No option "${want}" on ${field.label}`, field);

  const select = page.locator(field.selector).first();
  await select.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
  if ((await select.inputValue().catch(() => '')) === option.value) return;

  const box = select.locator(
    'xpath=following-sibling::span[contains(concat(" ", @class, " "), " select2 ")][1]//*[@role="combobox"]',
  );
  await box.scrollIntoViewIfNeeded().catch(() => {});
  await box.click({ timeout: FIELD_TIMEOUT_MS }).catch(() => {});

  const exact = new RegExp(`^\\s*${option.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const choice = page.locator('.select2-container--open .select2-results__option').filter({ hasText: exact }).first();
  const opened = await choice
    .waitFor({ state: 'visible', timeout: OPTION_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (opened) {
    await choice.click({ timeout: OPTION_TIMEOUT_MS });
  } else {
    await page.keyboard.press('Escape').catch(() => {});
    await select.evaluate((el, value) => {
      const $ = (window as unknown as { jQuery?: (e: Element) => { val(v: string): { trigger(e: string): void } } }).jQuery;
      if ($) $(el).val(value).trigger('change');
      else {
        (el as HTMLSelectElement).value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, option.value);
  }
  await page.waitForTimeout(150);
  if ((await select.inputValue().catch(() => '')) !== option.value) {
    throw new FillError(`Picked "${option.label}" on ${field.label}, but the dropdown did not take it`, field);
  }
}

/**
 * react-select (Greenhouse's board, Ashby, many custom forms).
 * The visible control is a text input with role="combobox"; options render
 * into a menu that may be portalled to document.body, so they are located
 * globally by role rather than inside the field's container.
 */
export async function fillReactSelect(page: Page, field: FormField, value: string | string[]): Promise<void> {
  const wants = Array.isArray(value) ? value : [value];
  const input = page.locator(field.selector).first();
  await input.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
  // Already showing the answer - a rerun of a page you or an earlier attempt
  // filled. Re-typing it gains nothing, and on Microsoft's dropdowns clearing
  // and retyping "Yes" found no option and failed a correctly answered field.
  if ((await verifyFilled(page, field, value)).ok) return;
  await input.scrollIntoViewIfNeeded().catch(() => {});

  // Rippling's EEO dropdowns are a <div role="combobox">: nothing to type
  // into, and a space in "Choose not to disclose" would toggle the menu.
  // SuccessFactors' picklists do not filter as you type, and every key
  // toggles the list open or shut; pick from the open list instead.
  const typeable = await input
    .evaluate(
      (e) => (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) && !e.closest('.sfCascadingPicklist'),
    )
    .catch(() => true);

  for (const want of wants) {
    await input.click({ timeout: FIELD_TIMEOUT_MS });
    if (!typeable) {
      if ((await input.getAttribute('aria-expanded')) !== 'true') await input.press('ArrowDown');
      const option = await waitForOption(page, field, want);
      if (!option) throw new FillError(`Could not find option "${want}" for ${field.label}`, field);
      await option.click();
      await page.waitForTimeout(120);
      continue;
    }
    // Typing narrows a long list (country pickers run to 240 entries) and also
    // opens the menu when a bare click did not.
    await input.fill('').catch(() => {});
    await input.type(want.slice(0, 40), { delay: 15 });

    let option = await waitForOption(page, field, want);
    // SuccessFactors' UI5 pick-lists may list nothing for typed words until
    // their dropdown arrow is pressed.
    if (!option && (await openUi5ValueHelp(input))) option = await waitForOption(page, field, want);
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

/**
 * Press the dropdown arrow of a SuccessFactors UI5 pick-list (`ui5-input`
 * with suggestions). Clicking or typing in the box does not always open its
 * list; the arrow, slotted into the input as its icon, does. False when the
 * control is not one.
 */
export async function openUi5ValueHelp(input: Locator): Promise<boolean> {
  return input
    .evaluate((el) => {
      const host = (el.getRootNode() as ShadowRoot).host;
      if (!host || !/^UI5-INPUT/.test(host.tagName)) return false;
      const arrow = host.querySelector<HTMLElement>(':scope > [slot="icon"]');
      if (!arrow) return false;
      arrow.click();
      return true;
    })
    .catch(() => false);
}
