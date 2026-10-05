import type { Locator, Page } from 'playwright';

/**
 * Getting past a job site's own account wall with the saved email and password.
 *
 * Workday and its kind put "Create Account" or "Sign In" in front of every
 * application. Both screens are the same few boxes everywhere - an email, one
 * or two passwords, maybe a consent tick - so this is plain DOM work: no model
 * reads the page and nothing about the password ever leaves this file except
 * into the site's own password box.
 *
 * Only for the site's own accounts. Someone else's identity provider (Google,
 * Microsoft, Okta) is a different trust decision and stays with the person.
 */

export interface SiteAccount {
  email: string;
  password: string;
}

export interface AccountAttempt {
  ok: boolean;
  detail: string;
}

const VISIBLE_PASSWORD = 'input[type="password"]:visible';

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

/** Workday ids first: its buttons sit under a click_filter overlay. */
const CREATE_BUTTON =
  '[data-automation-id="createAccountSubmitButton"], [data-automation-id="click_filter"][aria-label*="Create Account" i]';
const SIGN_IN_BUTTON =
  '[data-automation-id="signInSubmitButton"], [data-automation-id="click_filter"][aria-label*="Sign In" i]';
const SIGN_IN_LINK = '[data-automation-id="signInLink"]';
const CREATE_LINK = '[data-automation-id="createAccountLink"]';

const ALREADY_EXISTS = /already (exists|registered|in use|have an account)|account with this email/i;
const REJECTED =
  /(invalid|incorrect|wrong) (email|password|credentials|username)|password (is )?(incorrect|invalid)|does not meet|must contain|locked/i;

const IDENTITY_HOST =
  /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|signin\.aws\.amazon\.com|okta\.com|oktapreview\.com|auth0\.com|onelogin\.com|pingidentity\.com)$/i;

export async function signInOrRegister(page: Page, account: SiteAccount): Promise<AccountAttempt> {
  let host = '';
  try {
    host = new URL(page.url()).hostname;
  } catch {
    host = '';
  }
  if (IDENTITY_HOST.test(host)) {
    return { ok: false, detail: `${host} is a third-party sign-in; that one is yours to do.` };
  }

  // A wall with no password box yet: "Sign In" / "Create Account" buttons
  // that open the form. Prefer signing in - an account made on an earlier
  // application is the common case once a few have gone through.
  if (!(await visibleCount(page, VISIBLE_PASSWORD))) {
    const opened =
      (await clickFirst(page, SIGN_IN_LINK)) ||
      (await clickByName(page, /^(sign in|log ?in)$/i)) ||
      (await clickFirst(page, CREATE_LINK)) ||
      (await clickByName(page, /^(create (an )?account|register|sign up)$/i));
    if (!opened) return { ok: false, detail: 'Could not find the sign-in form on this page.' };
    await page.locator(VISIBLE_PASSWORD).first().waitFor({ timeout: 10_000 }).catch(() => {});
    if (!(await visibleCount(page, VISIBLE_PASSWORD))) {
      return { ok: false, detail: 'Opened the account screen, but no password box appeared.' };
    }
  }

  if ((await visibleCount(page, VISIBLE_PASSWORD)) >= 2) {
    const created = await submitCreate(page, account);
    if (created.ok) return created;
    // Made on an earlier application: switch to signing in.
    if (!ALREADY_EXISTS.test(await bodyText(page))) return created;
    const switched =
      (await clickFirst(page, SIGN_IN_LINK)) || (await clickByName(page, /^(sign in|log ?in)$/i));
    if (!switched) return { ok: false, detail: 'An account already exists, but there was no Sign In link to switch to.' };
    await page.waitForTimeout(1500);
  }
  return submitSignIn(page, account);
}

async function submitCreate(page: Page, account: SiteAccount): Promise<AccountAttempt> {
  if (!(await fillEmail(page, account.email))) {
    return { ok: false, detail: 'Found the Create Account form but not its email box.' };
  }
  const passwords = page.locator(VISIBLE_PASSWORD);
  const n = await passwords.count();
  for (let i = 0; i < n; i++) await passwords.nth(i).fill(account.password);

  // The consent tick ("I agree", "By creating an account…") is required to
  // submit; anything else checkable on this screen is the same kind of box.
  const boxes = page.locator('input[type="checkbox"]:visible');
  for (let i = 0; i < (await boxes.count()); i++) {
    const box = boxes.nth(i);
    if (!(await box.isChecked().catch(() => true))) await box.check({ force: true }).catch(() => {});
  }

  const clicked =
    (await clickFirst(page, CREATE_BUTTON)) ||
    (await clickByName(page, /^(create (an )?account|register|sign up|submit|continue)$/i));
  if (!clicked) return { ok: false, detail: 'Filled the Create Account form but found no button to submit it.' };
  return awaitOutcome(page, 'Created an account');
}

async function submitSignIn(page: Page, account: SiteAccount): Promise<AccountAttempt> {
  if (!(await fillEmail(page, account.email))) {
    return { ok: false, detail: 'Found the sign-in form but not its email box.' };
  }
  const password = page.locator(VISIBLE_PASSWORD).first();
  if (!(await password.isVisible().catch(() => false))) {
    // Two-screen sign-in: email, Next, then the password.
    await clickByName(page, /^(next|continue)$/i);
    await password.waitFor({ timeout: 10_000 }).catch(() => {});
  }
  if (!(await password.isVisible().catch(() => false))) {
    return { ok: false, detail: 'Entered the email, but no password box followed.' };
  }
  await password.fill(account.password);
  const clicked =
    (await clickFirst(page, SIGN_IN_BUTTON)) ||
    (await clickByName(page, /^(sign in|log ?in|continue|submit)$/i));
  if (!clicked) await password.press('Enter');
  return awaitOutcome(page, 'Signed in');
}

/** Signed in once the password boxes are gone; refused if the site says so. */
async function awaitOutcome(page: Page, success: string): Promise<AccountAttempt> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(750);
    if (!(await visibleCount(page, VISIBLE_PASSWORD))) {
      return { ok: true, detail: `${success} with your saved email.` };
    }
    const text = await bodyText(page);
    if (ALREADY_EXISTS.test(text)) return { ok: false, detail: 'An account with this email already exists.' };
    const refused = text.match(REJECTED);
    if (refused) return { ok: false, detail: `The site refused it: "${refused[0]}".` };
  }
  return { ok: false, detail: 'Submitted, but the sign-in screen did not go away.' };
}

async function fillEmail(page: Page, email: string): Promise<boolean> {
  const box = page.locator(EMAIL_INPUT).first();
  if (!(await box.isVisible().catch(() => false))) return false;
  await box.fill(email);
  return true;
}

async function clickFirst(page: Page, selector: string): Promise<boolean> {
  const el = page.locator(selector).first();
  if (!(await el.isVisible().catch(() => false))) return false;
  return click(el);
}

async function clickByName(page: Page, name: RegExp): Promise<boolean> {
  for (const role of ['button', 'link'] as const) {
    const el = page.getByRole(role, { name }).first();
    if (await el.isVisible().catch(() => false)) return click(el);
  }
  return false;
}

async function click(el: Locator): Promise<boolean> {
  return el
    .click({ timeout: 5000 })
    .catch(() => el.click({ force: true, timeout: 5000 }))
    .then(() => true)
    .catch(() => false);
}

async function visibleCount(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count().catch(() => 0);
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}
