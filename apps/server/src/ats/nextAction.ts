import type { Locator, Page } from 'playwright';

export type NextActionType = 'NEXT' | 'SUBMIT' | 'NONE';

export interface NextAction {
  type: NextActionType;
  label: string;
  locator: Locator;
}

const NEXT_PATTERNS = [
  /^next$/i,
  /^continue$/i,
  /^save and continue$/i,
  /^save & continue$/i,
  /^proceed$/i,
  /^go to next step$/i,
  /^next step$/i,
  /^continue to review$/i,
];

const SUBMIT_PATTERNS = [
  /^submit application$/i,
  /^submit$/i,
  /^review and submit$/i,
  /^apply$/i,
  /^send application$/i,
];

/**
 * Find the next meaningful action on the current application page.
 *
 * This is deliberately semantic: it looks for a button/input whose purpose is
 * clearly to move to the next step or to submit the application, instead of
 * blindly clicking the last visible control.
 */
export async function detectNextAction(page: Page): Promise<NextAction | null> {
  const candidates = [
    page.getByRole('button'),
    page.getByRole('link'),
    page.locator('button, input[type="submit"], input[type="button"], input[type="image"]'),
  ];

  for (const group of candidates) {
    const count = await group.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const locator = group.nth(i);
      const text = (await locator.innerText().catch(() => '') ?? '').replace(/\s+/g, ' ').trim();
      const aria = (await locator.getAttribute('aria-label').catch(() => '') ?? '').trim();
      const value = (await locator.getAttribute('value').catch(() => '') ?? '').trim();
      const label = text || aria || value;
      if (!label) continue;
      if (!(await locator.isVisible().catch(() => false))) continue;
      if (!(await locator.isEnabled().catch(() => true))) continue;

      if (SUBMIT_PATTERNS.some((re) => re.test(label))) {
        return { type: 'SUBMIT', label, locator };
      }

      if (NEXT_PATTERNS.some((re) => re.test(label))) {
        return { type: 'NEXT', label, locator };
      }
    }
  }

  const submit = page.locator('form button[type="submit"], form input[type="submit"]').first();
  if (await submit.count()) {
    const label = ((await submit.innerText().catch(() => '') ?? '') || (await submit.getAttribute('value').catch(() => '') ?? '')).trim();
    if (label) {
      return { type: 'SUBMIT', label, locator: submit };
    }
  }

  return null;
}
