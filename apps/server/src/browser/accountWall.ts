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
  /** For Create Account forms that ask for a name (SuccessFactors does). */
  firstName?: string;
  lastName?: string;
  /** Phone without its country code, and the ISO-2 country (SuccessFactors asks both). */
  phone?: string;
  countryCode?: string;
}

export interface AccountAttempt {
  ok: boolean;
  detail: string;
  /** The site answered that this email is already registered. */
  exists?: boolean;
  /** The site turned the email and password down. */
  refused?: boolean;
  /** The account was made and the site moved on to its Sign In screen. */
  signInNext?: boolean;
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
const BAD_LOGIN = /(invalid|incorrect|wrong) (email|password|credentials|username)|password (is )?(incorrect|invalid)|locked/i;
const REJECTED = new RegExp(`${BAD_LOGIN.source}|does not meet|must contain`, 'i');

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
  if (await isInlineAccount(page)) {
    return fillInlineAccount(page, account);
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
    if (created.signInNext) {
      const signedIn = await submitSignIn(page, account);
      return { ...signedIn, detail: `${created.detail} ${signedIn.detail}` };
    }
    // Made on an earlier application: switch to signing in.
    if (!created.exists) return created;
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
  const signedIn = await submitSignIn(page, account, emailEntered);
  if (signedIn.ok || !signedIn.refused) return signedIn;
  // "Invalid email or password" is what SuccessFactors says when no account
  // has this email yet. Registering is safe either way: an email that does
  // have an account is turned down with "already exists", and that stops here.
  const opened =
    (await clickFirst(page, CREATE_LINK)) ||
    (await clickByName(page, /^(create (an )?account|register|sign up)$/i));
  if (!opened) return signedIn;
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.locator(VISIBLE_PASSWORD).nth(1).waitFor({ timeout: 15_000 }).catch(() => {});
  const created = (await isInlineAccount(page))
    ? await fillInlineAccount(page, account)
    : (await visibleCount(page, VISIBLE_PASSWORD)) >= 2
      ? await submitCreate(page, account)
      : { ok: false, detail: 'Opened Create Account, but no password boxes appeared.' };
  const after = created.signInNext ? await submitSignIn(page, account) : null;
  return {
    ...created,
    ...after,
    detail: `Sign In refused the saved email and password, so made an account instead. ${created.detail}${after ? ` ${after.detail}` : ''}`,
  };
}

/** SuccessFactors quick apply: the account boxes are part of the application. */
async function isInlineAccount(page: Page): Promise<boolean> {
  const count = (sel: string) => page.locator(sel).count().catch(() => 0);
  return (await count('#fbqa_apply')) > 0 && (await count('input[name="fbclc_pwd"]')) > 0;
}

/**
 * Fill the account boxes that sit on the application itself and stop there.
 *
 * Nothing is ticked and nothing is pressed: the only button is the
 * application's own Apply, and the boxes beside these (job alerts, marketing
 * opt-in) are questions on the form like any other, answered with the rest.
 * Each box is left with a blur, which is when the site checks it - its
 * "Retype" boxes refuse a paste, which `fill` does not do.
 */
async function fillInlineAccount(page: Page, account: SiteAccount): Promise<AccountAttempt> {
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
  return awaitOutcome(page, 'Created an account', before);
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
  const before = await bodyText(page);
  const clicked =
    (await clickFirst(page, SIGN_IN_BUTTON)) ||
    (await clickByName(page, /^(sign in|log ?in|continue|submit)$/i));
  if (!clicked) await password.press('Enter');
  return awaitOutcome(page, 'Signed in', before);
}

/**
 * Signed in once the password boxes are gone; refused if the site says so.
 *
 * `before` is the page text from just before the submit. Only wording that
 * appears after it counts: SuccessFactors heads its sign-in form "Already
 * have an account?", which read as "already exists" before the site had
 * answered at all.
 */
async function awaitOutcome(page: Page, success: string, before: string): Promise<AccountAttempt> {
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
    if (success === 'Created an account' && (await isSignInScreen(page))) {
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

/**
 * The rest of SuccessFactors' standalone Create Account (Nomura): phone code,
 * mobile, country of residence, who may see the profile, and the data privacy
 * statement. Without them it refuses the whole form ("The following fields
 * require a valid input: Country/Region Code, Mobile Phone, ...").
 *
 * Visibility gets the narrower choice, "Only recruiters managing jobs I apply
 * to". The privacy statement is a dialog that sets the hidden fbclc_dpcsId
 * once accepted, and it is per country, so the country goes in first.
 * A form without these boxes is left alone.
 */
async function fillSuccessFactorsExtras(page: Page, account: SiteAccount): Promise<AccountAttempt> {
  const visible = (sel: string) => page.locator(sel).first().isVisible().catch(() => false);
  const country = account.countryCode?.toUpperCase();
  const pick = async (sel: string): Promise<boolean> => {
    if (!(await visible(sel))) return true;
    if (await page.locator(sel).first().inputValue().catch(() => '')) return true;
    if (!country) return false;
    const done = await page.locator(sel).first().selectOption(country, { timeout: 3000 }).catch(() => []);
    await page.locator(sel).first().dispatchEvent('blur').catch(() => {});
    return done.length > 0;
  };
  const missing: string[] = [];
  if (!(await pick('select[name="fbclc_ituCode"]'))) missing.push('Country/Region Code');
  if (await visible('input[name="fbclc_phoneNumber"]')) {
    if (account.phone) await fillBox(page, 'input[name="fbclc_phoneNumber"]', /^\s*mobile phone/i, account.phone);
    if (!(await page.locator('input[name="fbclc_phoneNumber"]').first().inputValue().catch(() => ''))) {
      missing.push('Mobile Phone');
    }
  }
  if (!(await pick('select[name="fbclc_country"]'))) missing.push('Country/Region of Residence');
  if (missing.length) {
    return { ok: false, detail: `The Create Account form needs ${missing.join(', ')}, which your profile does not have.` };
  }

  const radios = page.locator('input[name="fbclc_searPref"]');
  if ((await radios.count().catch(() => 0)) && !(await page.locator('input[name="fbclc_searPref"]:checked').count())) {
    const narrow = page.locator('input[name="fbclc_searPref"][value="2"]').first();
    if (!(await tick(page, (await narrow.count()) ? narrow : radios.last()))) {
      return { ok: false, detail: 'Could not set "Make My Profile Visible to" on the Create Account form.' };
    }
  }

  const dpcs = page.locator('#fbclc_dpcsId');
  if ((await dpcs.count().catch(() => 0)) && !(await dpcs.inputValue().catch(() => ''))) {
    await page.locator('#dataPrivacyId').first().click({ timeout: 5000 }).catch(() => {});
    const accept = page.getByRole('button', { name: /^\s*(accept|i agree|accept and continue)\s*$/i });
    await accept.first().waitFor({ timeout: 15_000 }).catch(() => {});
    // The Accept button can stay disabled until the statement is scrolled through.
    await page
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] *, .sfDialogBox *'))) {
          if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight;
        }
      })
      .catch(() => {});
    const n = await accept.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = accept.nth(i);
      if ((await b.isVisible().catch(() => false)) && (await click(b))) break;
    }
    await page
      .waitForFunction(() => !!(document.querySelector('#fbclc_dpcsId') as HTMLInputElement | null)?.value, null, {
        timeout: 10_000,
      })
      .catch(() => {});
    if (!(await dpcs.inputValue().catch(() => ''))) {
      return { ok: false, detail: 'Filled the Create Account form but could not accept its data privacy statement.' };
    }
  }
  return { ok: true, detail: '' };
}

/** One password box and a Sign In button: the site's sign-in form. */
async function isSignInScreen(page: Page): Promise<boolean> {
  if ((await visibleCount(page, VISIBLE_PASSWORD)) !== 1) return false;
  if (await page.locator(SIGN_IN_BUTTON).first().isVisible().catch(() => false)) return true;
  return page
    .getByRole('button', { name: /^(sign in|log ?in)$/i })
    .first()
    .isVisible()
    .catch(() => false);
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

/** The first match of `re` that `text` holds more often than `before` did. */
function newly(text: string, before: string, re: RegExp): string | null {
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

/**
 * Fill an empty, editable text box - found by `selector`, else by its label -
 * then leave it (sites validate on blur).
 */
async function fillBox(page: Page, selector: string, label: RegExp, value: string): Promise<void> {
  const byId = page.locator(selector).first();
  const box = (await byId.isVisible().catch(() => false)) ? byId : page.getByLabel(label).first();
  if (!(await box.isVisible().catch(() => false))) return;
  if (!(await box.isEditable().catch(() => false))) return;
  if (await box.inputValue().catch(() => '')) return;
  await box.fill(value).catch(() => {});
  await box.dispatchEvent('blur').catch(() => {});
}

/**
 * A box that has to be ticked to make the account: Workday's own, one the
 * page marks required, or one whose wording is about terms and privacy.
 */
async function isConsentBox(box: Locator): Promise<boolean> {
  return box
    .evaluate((el, consentSel) => {
      const input = el as HTMLInputElement;
      if (input.matches(consentSel) || input.required || input.getAttribute('aria-required') === 'true') return true;
      const label =
        (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent) ||
        input.closest('label')?.textContent ||
        input.parentElement?.textContent ||
        '';
      return /\b(agree|accept|terms|privacy|consent|acknowledge|i have read)\b/i.test(label);
    }, CONSENT_BOX)
    .catch(() => false);
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
