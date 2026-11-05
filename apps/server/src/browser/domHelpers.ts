import type { Locator, Page } from 'playwright';

/**
 * Shared DOM manipulation utilities for browser automation.
 *
 * These functions abstract common Playwright operations and are reused across
 * multiple browser automation modules (microsoftAccount, accountWall, etc.).
 */

/**
 * Click the primary/submit button on a page (Next, Sign in, Yes, etc.).
 * Falls back to pressing Enter on a specific field if the button click fails.
 */
export async function pressPrimary(page: Page, selector: string, field?: string): Promise<void> {
  const button = page.locator(selector).first();
  const clicked = await button
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked && field) await page.locator(field).first().press('Enter').catch(() => {});
}

/**
 * Click a button or link by its text content (case-insensitive regex).
 */
export async function clickText(page: Page, name: RegExp): Promise<boolean> {
  for (const role of ['button', 'link'] as const) {
    const control = page.getByRole(role, { name }).first();
    if (await control.isVisible().catch(() => false)) {
      return control
        .click({ timeout: 3000 })
        .then(() => true)
        .catch(() => false);
    }
  }
  return false;
}

/**
 * Check if a selector is visible on the page.
 */
export async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().isVisible().catch(() => false);
}

/**
 * Get the page body text as a normalized string.
 */
export async function bodyText(page: Page): Promise<string> {
  return page
    .locator('body')
    .innerText({ timeout: 2000 })
    .then((t) => t.replace(/\s+/g, ' ').trim())
    .catch(() => '');
}

/**
 * Extract the hostname from a page URL safely.
 */
export function hostOf(page: Page): string {
  try {
    return new URL(page.url()).hostname;
  } catch {
    return '';
  }
}

/**
 * Escape special regex characters in a string.
 */
export function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Click the first visible element matching a selector.
 */
export async function clickFirst(page: Page, selector: string): Promise<boolean> {
  const el = page.locator(selector).first();
  if (!(await el.isVisible().catch(() => false))) return false;
  return click(el);
}

/**
 * Click a button or link by its name (case-insensitive regex).
 */
export async function clickByName(page: Page, name: RegExp): Promise<boolean> {
  for (const role of ['button', 'link'] as const) {
    const el = page.getByRole(role, { name }).first();
    if (await el.isVisible().catch(() => false)) return click(el);
  }
  return false;
}

/**
 * Click a locator with fallback to force click.
 */
export async function click(el: Locator): Promise<boolean> {
  return el
    .click({ timeout: 5000 })
    .catch(() => el.click({ force: true, timeout: 5000 }))
    .then(() => true)
    .catch(() => false);
}

/**
 * Count visible elements matching a selector.
 */
export async function visibleCount(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count().catch(() => 0);
}

/**
 * Fill an empty, editable text box - found by selector, else by its label.
 * Then leaves it (sites validate on blur).
 */
export async function fillBox(page: Page, selector: string, label: RegExp, value: string): Promise<void> {
  const byId = page.locator(selector).first();
  const box = (await byId.isVisible().catch(() => false)) ? byId : page.getByLabel(label).first();
  if (!(await box.isVisible().catch(() => false))) return;
  if (!(await box.isEditable().catch(() => false))) return;
  if (await box.inputValue().catch(() => '')) return;
  await box.fill(value).catch(() => {});
  await box.dispatchEvent('blur').catch(() => {});
}

/**
 * Fill an email field with validation.
 * If selector is not provided, uses default email input selectors.
 */
export async function fillEmail(page: Page, selectorOrEmail: string, email?: string): Promise<boolean> {
  const EMAIL_INPUT = [
    'input[data-automation-id="email"]',
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[name*="user" i]',
    'input[id*="user" i]',
  ]
    .map((s) => `${s}:visible`)
    .join(', ');

  const selector = email ? selectorOrEmail : EMAIL_INPUT;
  const emailValue = email ?? selectorOrEmail;

  const box = page.locator(selector).first();
  if (!(await box.isVisible().catch(() => false))) return false;
  // After an email-first step the address is often shown back read-only.
  if (!(await box.isEditable().catch(() => false))) return Boolean(await box.inputValue().catch(() => ''));
  await box.fill(emailValue);
  return true;
}

/**
 * Tick a checkbox and make sure it took.
 *
 * Styled checkboxes hide the real input under a drawn box, so a click at its
 * centre can land on the drawing. Try the input, then its label, then a click
 * dispatched straight to the input (React still sees the change).
 */
export async function tick(page: Page, box: Locator): Promise<boolean> {
  const checked = () => box.isChecked({ timeout: 1000 }).catch(() => false);
  if (await checked()) return true;
  await box.check({ force: true, timeout: 3000 }).catch(() => {});
  if (await checked()) return true;
  const id = await box.getAttribute('id').catch(() => null);
  if (id) await page.locator(`label[for="${id}"]`).first().click({ timeout: 3000 }).catch(() => {});
  if (await checked()) return true;
  await box.dispatchEvent('click').catch(() => {});
  return checked();
}

/**
 * Check if a checkbox is a consent box (required or terms-related).
 */
export async function isConsentBox(box: Locator, consentSelector?: string): Promise<boolean> {
  return box
    .evaluate((el, consentSel) => {
      const input = el as HTMLInputElement;
      if (consentSel && input.matches(consentSel)) return true;
      if (input.required || input.getAttribute('aria-required') === 'true') return true;
      const label =
        (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent) ||
        input.closest('label')?.textContent ||
        input.parentElement?.textContent ||
        '';
      return /\b(agree|accept|terms|privacy|consent|acknowledge|i have read)\b/i.test(label);
    }, consentSelector ?? '')
    .catch(() => false);
}

/**
 * Get site error text from error locators.
 * If selector is not provided, uses default error selectors.
 */
export async function siteError(page: Page, errorSelector?: string): Promise<string | null> {
  const SITE_ERROR =
    '[data-automation-id="errorMessage"]:visible, [data-automation-id="inputAlert"]:visible, [role="alert"]:visible';
  const selector = errorSelector ?? SITE_ERROR;
  const texts = await page
    .locator(selector)
    .allInnerTexts()
    .catch(() => [] as string[]);
  const said = texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return said.length ? said.join(' ').slice(0, 300) : null;
}

/**
 * Find the first match of a regex that appears more often in text than in before.
 */
export function newly(text: string, before: string, re: RegExp): string | null {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const tally = (s: string) => {
    const seen = new Map<string, number>();
    for (const [m] of s.matchAll(global)) seen.set(m.toLowerCase(), (seen.get(m.toLowerCase()) ?? 0) + 1);
    return seen;
  };
  const was = tally(before);
  for (const [m, n] of tally(text)) if (n > (was.get(m) ?? 0)) return m;
  return null;
}
