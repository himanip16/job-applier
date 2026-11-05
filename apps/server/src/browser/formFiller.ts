import type { Page } from 'playwright';
import type { SiteAccount, AccountAttempt } from './accountWall';
import { bodyText, click, clickFirst, clickByName, fillBox, fillEmail, isConsentBox, newly, siteError, tick, visibleCount } from './domHelpers';
import { fillSuccessFactorsExtras } from './successFactorsAdapter';
import { isSignInScreen } from './formDetector';

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

const CREATE_BUTTON =
  '[data-automation-id="createAccountSubmitButton"], [data-automation-id="click_filter"][aria-label*="Create Account" i]';
const SIGN_IN_BUTTON =
  '[data-automation-id="signInSubmitButton"], [data-automation-id="click_filter"][aria-label*="Sign In" i]';
const CONSENT_BOX = 'input[data-automation-id="createAccountCheckbox"]';
const SITE_ERROR =
  '[data-automation-id="errorMessage"]:visible, [data-automation-id="inputAlert"]:visible, [role="alert"]:visible';

const ALREADY_EXISTS = /already (exists|registered|in use|have an account)|account with this email/i;
const BAD_LOGIN = /(invalid|incorrect|wrong) (email|password|credentials|username)|password (is )?(incorrect|invalid)|locked/i;
const REJECTED = new RegExp(`${BAD_LOGIN.source}|does not meet|must contain`, 'i');

/**
 * Fill the account boxes that sit on the application itself and stop there.
 *
 * Nothing is ticked and nothing is pressed: the only button is the
 * application's own Apply, and the boxes beside these (job alerts, marketing
 * opt-in) are questions on the form like any other, answered with the rest.
 * Each box is left with a blur, which is when the site checks it - its
 * "Retype" boxes refuse a paste, which `fill` does not do.
 */
export async function fillInlineAccount(page: Page, account: SiteAccount): Promise<AccountAttempt> {
  const boxes: Array<[string, string]> = [
    ['input[name="fbclc_userName"]', account.email],
    ['input[name="fbclc_emailConf"]', account.email],
    ['input[name="fbclc_pwd"]', account.password],
    ['input[name="fbclc_pwdConf"]', account.password],
  ];
  for (const [selector, value] of boxes) {
    const box = page.locator(selector).first();
    if (!(await box.isVisible().catch(() => false))) continue;
    if (!(await box.isEditable().catch(() => false))) continue;
    await box.fill(value);
    await box.dispatchEvent('blur').catch(() => {});
  }
  const empty = await page
    .locator('input[name^="fbclc_pwd"]')
    .evaluateAll((els) => els.filter((e) => !(e as HTMLInputElement).value).length)
    .catch(() => 1);
  if (empty) return { ok: false, detail: 'Could not fill the account password boxes on this application.' };
  const said = await siteError(page);
  if (said && REJECTED.test(said)) return { ok: false, detail: `The site refused the password: "${said}".` };
  return { ok: true, detail: 'Filled the account boxes on this application with your saved email and password.' };
}

export async function submitCreate(page: Page, account: SiteAccount, emailEntered = false): Promise<AccountAttempt> {
  if (!(await fillEmail(page, EMAIL_INPUT, account.email)) && !emailEntered) {
    return { ok: false, detail: 'Found the Create Account form but not its email box.' };
  }
  const passwords = page.locator(VISIBLE_PASSWORD);
  const n = await passwords.count();
  // Left with a blur, so rule hints the site draws on blur ("Password must
  // contain...") are up before the page text is read for what is new.
  for (let i = 0; i < n; i++) {
    await passwords.nth(i).fill(account.password);
    await passwords.nth(i).dispatchEvent('blur').catch(() => {});
  }

  // SuccessFactors' form also wants the email typed again and a name, and
  // refuses the whole form ("The following fields require a valid input:
  // Retype Email Address, First Name, Last Name") without them.
  // Its labels start with a newline and indent, and a regex label is tested
  // against that raw text - hence `^\s*`, and the SuccessFactors ids first.
  await fillBox(page, 'input[name="fbclc_emailConf"]', /^\s*(retype|confirm|re-?enter|verify|repeat)\b.*e-?mail/i, account.email);
  if (account.firstName) await fillBox(page, 'input[name="fbclc_fName"]', /^\s*(first|given) name/i, account.firstName);
  if (account.lastName) await fillBox(page, 'input[name="fbclc_lName"]', /^\s*((last|family) name|surname)/i, account.lastName);
  const extras = await fillSuccessFactorsExtras(page, account);
  if (!extras.ok) return extras;

  // The consent tick ("I agree", "By creating an account…") is required to
  // submit. Job alerts and marketing opt-ins on the same screen are not, and
  // are left as the site set them.
  // Not only `:visible`: Workday's createAccountCheckbox is a transparent
  // input under a drawn box, which can measure as nothing.
  const boxes = page.locator(`${CONSENT_BOX}, form input[type="checkbox"]:visible`);
  for (let i = 0; i < (await boxes.count()); i++) {
    const box = boxes.nth(i);
    if (!(await isConsentBox(box))) continue;
    if (!(await tick(page, box))) {
      return { ok: false, detail: 'Filled the Create Account form but could not tick its terms checkbox.' };
    }
  }

  const before = await bodyText(page);
  const clicked =
    (await clickFirst(page, CREATE_BUTTON)) ||
    (await clickByName(page, /^(create (an )?account|register|sign up|submit|continue)$/i));
  if (!clicked) return { ok: false, detail: 'Filled the Create Account form but found no button to submit it.' };
  return awaitOutcome(page, 'Created an account', before, isSignInScreen);
}

export async function submitSignIn(page: Page, account: SiteAccount, emailEntered = false): Promise<AccountAttempt> {
  // The password box can draw before the email box above it.
  if (!emailEntered) await page.locator(EMAIL_INPUT).first().waitFor({ timeout: 10_000 }).catch(() => {});
  if (!(await fillEmail(page, EMAIL_INPUT, account.email)) && !emailEntered) {
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
  const before = await bodyText(page);
  const clicked =
    (await clickFirst(page, SIGN_IN_BUTTON)) ||
    (await clickByName(page, /^(sign in|log ?in|continue|submit)$/i));
  if (!clicked) await password.press('Enter');
  return awaitOutcome(page, 'Signed in', before, () => Promise.resolve(false));
}

/**
 * Signed in once the password boxes are gone; refused if the site says so.
 *
 * `before` is the page text from just before the submit. Only wording that
 * appears after it counts: SuccessFactors heads its sign-in form "Already
 * have an account?", which read as "already exists" before the site had
 * answered at all.
 */
async function awaitOutcome(page: Page, success: string, before: string, checkSignInScreen?: (page: Page) => Promise<boolean>): Promise<AccountAttempt> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(750);
    if (!(await visibleCount(page, VISIBLE_PASSWORD))) {
      // A form that posts back reloads the page: the password box is gone for
      // a moment and then the same sign-in screen returns with an error. And
      // Workday blanks the whole step for several seconds while it decides,
      // then often draws Sign In again. Only a next screen that has actually
      // drawn, with no password box on it, counts.
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      const next = await nextScreen(page);
      if (next === 'drawn') return { ok: true, detail: `${success} with your saved email.` };
      if (next === 'blank') {
        return { ok: false, detail: 'Submitted, but the page stayed blank afterwards.' };
      }
    }
    // Workday answers a new account with its one-password Sign In screen.
    if (success === 'Created an account' && checkSignInScreen && (await checkSignInScreen(page))) {
      return { ok: false, signInNext: true, detail: 'Created an account; the site asked to sign in with it.' };
    }
    const text = await bodyText(page);
    if (newly(text, before, ALREADY_EXISTS)) {
      return { ok: false, exists: true, detail: 'An account with this email already exists.' };
    }
    // Not the policy wording here: "Password must contain..." is a rules
    // list on SuccessFactors' Create Account, drawn whenever a box is left.
    // An actual policy failure shows up as a site error, read below.
    const refused = newly(text, before, BAD_LOGIN);
    if (refused) return { ok: false, refused: true, detail: `The site refused it: "${refused}".` };
  }
  const said = await siteError(page);
  if (said && REJECTED.test(said)) return { ok: false, refused: true, detail: `The site refused it: "${said}".` };
  return {
    ok: false,
    detail: said
      ? `Submitted, but the site said: "${said}".`
      : 'Submitted, but the sign-in screen did not go away.',
  };
}

/**
 * What the page settles on once the password boxes have gone: a password box
 * again, a screen with something to act on, or nothing at all within 25s (a Workday
 * step was seen blank for over 10s while loading).
 * The header, the honeypot and Workday's "Back to Job Posting" stay up
 * through the blank gap, so they do not count. Something drawn has to still
 * be there a second later.
 */
async function nextScreen(page: Page): Promise<'password' | 'drawn' | 'blank'> {
  let drawnSince = 0;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await visibleCount(page, VISIBLE_PASSWORD)) return 'password';
    const drawn = await page
      .evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            'input:not([type="hidden"]):not([type="password"]), select, textarea, button, [role="combobox"], [role="button"]',
          ),
        ).some(
          (el) =>
            el.checkVisibility() &&
            !el.closest('header, nav, [role="banner"], [role="navigation"], [data-automation-id="header"]') &&
            !/beecatcher|honey-?pot|backToJobPosting/i.test(
              `${el.dataset.automationId ?? ''} ${el.getAttribute('name') ?? ''}`,
            ),
        ),
      )
      .catch(() => false);
    if (!drawn) drawnSince = 0;
    else if (!drawnSince) drawnSince = Date.now();
    else if (Date.now() - drawnSince >= 1000) return 'drawn';
    await page.waitForTimeout(250);
  }
  return 'blank';
}
