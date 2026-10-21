import type { Locator, Page } from 'playwright';
import type { FormField } from '@ja/shared';

export const FIELD_TIMEOUT_MS = 10_000;
export const OPTION_TIMEOUT_MS = 5_000;

export class FillError extends Error {
  constructor(
    message: string,
    readonly field: FormField,
    readonly recoverable = true,
    /** The options the list did show, when it had none for the answer. */
    readonly seen: string[] = [],
  ) {
    super(message);
    this.name = 'FillError';
  }
}

export function asOne(value: string | string[], field: FormField): string {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new FillError(`${field.label} takes one value, got ${value.length}`, field);
    }
    return value[0]!;
  }
  return value;
}

export function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/** Resolve the human-visible text attached to an input. */
export async function labelTextFor(page: Page, input: Locator): Promise<string> {
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
