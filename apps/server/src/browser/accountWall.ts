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
const CONSENT_BOX = 'input[data-automation-id="createAccountCheckbox"]';
/** Where Workday and most React forms say why a submit was refused. */
const SITE_ERROR =
  '[data-automation-id="errorMessage"]:visible, [data-automation-id="inputAlert"]:visible, [role="alert"]:visible';
const SIGN_IN_LINK ='[data-automation-id="signInLink"]';
const CREATE_LINK = '[data-automation-id="createAccountLink"]';
/** Workday's sign-in chooser: Google / LinkedIn buttons, then "Sign in with email". */
const EMAIL_SIGN_IN_BUTTON = '[data-automation-id="SignInWithEmailButton"]';

const ALREADY_EXISTS = /already (exists|registered|in use|have an account)|account with this email/i;
const REJECTED =
  /(invalid|incorrect|wrong) (email|password|credentials|username)|password (is )?(incorrect|invalid)|does not meet|must contain|locked/i;

const IDENTITY_HOST =
  /(^|\.)(accounts\.google\.com|idmsa\.apple\.com|login\.microsoftonline\.com|login\.live\.com|signin\.aws\.amazon\.com|okta\.com|oktapreview\.com|auth0\.com|onelogin\.com|pingidentity\.com)$/i;

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

  // Email-first wall ("Log in or create account": one email box and
  // Continue). The site decides from the email which screen comes next - a
  // password to sign in, or a new password (and confirm) to register.
  let emailEntered = false;
  if (!(await visibleCount(page, VISIBLE_PASSWORD)) && (await isEmailFirst(page))) {
    await fillEmail(page, account.email);
    if (!(await clickByName(page, /^(continue|next)$/i))) {
      await page.locator(EMAIL_INPUT).first().press('Enter').catch(() => {});
    }
    await page.locator(VISIBLE_PASSWORD).first().waitFor({ timeout: 15_000 }).catch(() => {});
    if (!(await visibleCount(page, VISIBLE_PASSWORD))) {
      const said = await siteError(page);
      return {
        ok: false,
        detail: said
          ? `Entered the email and pressed Continue; the site said: "${said}".`
          : 'Entered the email and pressed Continue, but no password box followed.',
      };
    }
    emailEntered = true;
  }

  // A wall with no password box yet: "Sign In" / "Create Account" buttons
  // that open the form. Prefer signing in - an account made on an earlier
  // application is the common case once a few have gone through.
  if (!(await visibleCount(page, VISIBLE_PASSWORD))) {
    const opened =
      // Pick the site's own email sign-in over the Google/LinkedIn buttons.
      (await clickFirst(page, EMAIL_SIGN_IN_BUTTON)) ||
      (await clickByName(page, /^(sign in|log ?in|continue) with email$/i)) ||
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
    const created = await submitCreate(page, account, emailEntered);
    if (created.ok) return created;
    // Made on an earlier application: switch to signing in.
    if (!ALREADY_EXISTS.test(await bodyText(page))) return created;
    const switched =
      (await clickFirst(page, SIGN_IN_LINK)) || (await clickByName(page, /^(sign in|log ?in)$/i));
    if (!switched) return { ok: false, detail: 'An account already exists, but there was no Sign In link to switch to.' };
    // Workday blanks the form while it swaps screens; a fixed pause read that
    // gap as "no email box". Wait for the one-password Sign In form instead.
    await page
      .waitForFunction(
        (sel) => Array.from(document.querySelectorAll(sel)).filter((el) => (el as HTMLElement).checkVisibility()).length === 1,
        'input[type="password"]',
        { timeout: 15_000, polling: 250 },
      )
      .catch(() => {});
    const signedIn = await submitSignIn(page, account, emailEntered);
    return signedIn.ok
      ? signedIn
      : { ...signedIn, detail: `An account with this email already exists, so switched to Sign In. ${signedIn.detail}` };
  }
  return submitSignIn(page, account, emailEntered);
}

/** An email box with a Continue/Next button and no password box anywhere on the page. */
async function isEmailFirst(page: Page): Promise<boolean> {
  if (!(await page.locator(EMAIL_INPUT).first().isVisible().catch(() => false))) return false;
  if (await page.locator('input[type="password"]').count().catch(() => 0)) return false;
  for (const role of ['button', 'link'] as const) {
    if (await page.getByRole(role, { name: /^(continue|next)$/i }).first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function submitCreate(page: Page, account: SiteAccount, emailEntered = false): Promise<AccountAttempt> {
  if (!(await fillEmail(page, account.email)) && !emailEntered) {
    return { ok: false, detail: 'Found the Create Account form but not its email box.' };
  }
  const passwords = page.locator(VISIBLE_PASSWORD);
  const n = await passwords.count();
  for (let i = 0; i < n; i++) await passwords.nth(i).fill(account.password);

  // The consent tick ("I agree", "By creating an account…") is required to
  // submit; anything else checkable on this screen is the same kind of box.
  // Not only `:visible`: Workday's createAccountCheckbox is a transparent
  // input under a drawn box, which can measure as nothing.
  const boxes = page.locator(`${CONSENT_BOX}, form input[type="checkbox"]:visible`);
  for (let i = 0; i < (await boxes.count()); i++) {
    if (!(await tick(page, boxes.nth(i)))) {
      return { ok: false, detail: 'Filled the Create Account form but could not tick its terms checkbox.' };
    }
  }

  const clicked =
    (await clickFirst(page, CREATE_BUTTON)) ||
    (await clickByName(page, /^(create (an )?account|register|sign up|submit|continue)$/i));
  if (!clicked) return { ok: false, detail: 'Filled the Create Account form but found no button to submit it.' };
  return awaitOutcome(page, 'Created an account');
}

async function submitSignIn(page: Page, account: SiteAccount, emailEntered = false): Promise<AccountAttempt> {
  // The password box can draw before the email box above it.
  if (!emailEntered) await page.locator(EMAIL_INPUT).first().waitFor({ timeout: 10_000 }).catch(() => {});
  if (!(await fillEmail(page, account.email)) && !emailEntered) {
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
  const said = await siteError(page);
  return {
    ok: false,
    detail: said
      ? `Submitted, but the site said: "${said}".`
      : 'Submitted, but the sign-in screen did not go away.',
  };
}

/**
 * Tick a checkbox and make sure it took.
 *
 * Styled checkboxes hide the real input under a drawn box, so a click at its
 * centre can land on the drawing. Try the input, then its label, then a click
 * dispatched straight to the input (React still sees the change).
 */
async function tick(page: Page, box: Locator): Promise<boolean> {
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

async function siteError(page: Page): Promise<string | null> {
  const texts = await page
    .locator(SITE_ERROR)
    .allInnerTexts()
    .catch(() => [] as string[]);
  const said = texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return said.length ? said.join(' ').slice(0, 300) : null;
}

async function fillEmail(page: Page, email: string): Promise<boolean> {
  const box = page.locator(EMAIL_INPUT).first();
  if (!(await box.isVisible().catch(() => false))) return false;
  // After an email-first step the address is often shown back read-only.
  if (!(await box.isEditable().catch(() => false))) return Boolean(await box.inputValue().catch(() => ''));
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
