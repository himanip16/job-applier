import type { Page } from 'playwright';

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

const VISIBLE_PASSWORD = 'input[type="password"]:visible';

const SIGN_IN_BUTTON =
  '[data-automation-id="signInSubmitButton"], [data-automation-id="click_filter"][aria-label*="Sign In" i]';

/**
 * SuccessFactors quick apply: the account boxes are part of the application.
 */
export async function isInlineAccount(page: Page): Promise<boolean> {
  const count = (sel: string) => page.locator(sel).count().catch(() => 0);
  return (await count('#fbqa_apply')) > 0 && (await count('input[name="fbclc_pwd"]')) > 0;
}

/**
 * An email box with a Continue/Next button and no password box anywhere on the page.
 */
export async function isEmailFirst(page: Page): Promise<boolean> {
  if (!(await page.locator(EMAIL_INPUT).first().isVisible().catch(() => false))) return false;
  if (await page.locator('input[type="password"]').count().catch(() => 0)) return false;
  for (const role of ['button', 'link'] as const) {
    if (await page.getByRole(role, { name: /^(continue|next)$/i }).first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

/**
 * One password box and a Sign In button: the site's sign-in form.
 */
export async function isSignInScreen(page: Page): Promise<boolean> {
  if ((await page.locator(VISIBLE_PASSWORD).count().catch(() => 0)) !== 1) return false;
  if (await page.locator(SIGN_IN_BUTTON).first().isVisible().catch(() => false)) return true;
  return page
    .getByRole('button', { name: /^(sign in|log ?in)$/i })
    .first()
    .isVisible()
    .catch(() => false);
}
