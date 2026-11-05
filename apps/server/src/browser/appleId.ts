import type { FrameLocator, Page } from 'playwright';

/**
 * Signing in to an Apple Account on idmsa.apple.com with the saved Apple ID.
 *
 * Apple Careers sends every application through this (see ats/adapters/apple.ts).
 * Checked live in October 2026: the form is inside the `#aid-auth-widget-iFrame`
 * widget, and it is two screens behind one button -
 *
 *   - `#account_name_text_field` ("Email or Phone Number") and `#sign-in`
 *     ("Continue"), disabled until something is typed;
 *   - `#password_text_field`, mounted from the start but inside a
 *     `.password[aria-hidden="true"]` box until the Apple ID is accepted, then
 *     the same `#sign-in` again.
 *
 * After the password Apple asks for a six-digit code it pushes to your own
 * devices. That code never reaches email, so it cannot be fetched like the
 * job sites' codes: the run stops there for you. Ticking "Trust" afterwards is
 * what makes later applications skip all of this - the run browser's profile
 * keeps the session.
 *
 * Plain DOM work, like accountWall.ts: no model sees the page, and the
 * password goes nowhere but Apple's own password box.
 */

export interface AppleAccount {
  appleId: string;
  password: string;
}

export interface AppleAttempt {
  outcome: 'signed-in' | 'needs-code' | 'failed';
  detail: string;
}

const WIDGET = '#aid-auth-widget-iFrame';
const APPLE_ID_BOX = '#account_name_text_field';
const PASSWORD_BOX = '.password:not([aria-hidden="true"]) #password_text_field';
const CONTINUE = '#sign-in';
/** The code boxes on the two-factor screen, and its wording as a fallback. */
const CODE_BOXES = 'input.form-security-code-input, input[autocomplete="one-time-code"]';
const CODE_SCREEN = /two-factor authentication|verification code|sent to your (apple )?devices|enter (the )?code/i;
const REFUSED =
  /check the account information you entered|incorrect|not (been )?(found|valid)|locked|disabled|try again later|could not be completed/i;

export const onAppleSignIn = (page: Page): boolean => /^idmsa\.apple\.com$/i.test(hostOf(page));

export async function signInWithAppleId(page: Page, account: AppleAccount): Promise<AppleAttempt> {
  if (!onAppleSignIn(page)) return { outcome: 'failed', detail: 'This is not the Apple Account sign-in page.' };
  const widget = page.frameLocator(WIDGET);

  // A remembered Apple ID can skip straight to the code, or to the password.
  const first = await firstOf(widget, [APPLE_ID_BOX, PASSWORD_BOX, CODE_BOXES], 20_000);
  if (first === null) return { outcome: 'failed', detail: 'The Apple sign-in form did not appear.' };
  if (first === CODE_BOXES) return needsCode();

  if (first === APPLE_ID_BOX) {
    const box = widget.locator(APPLE_ID_BOX);
    await box.fill(account.appleId);
    if (!(await pressContinue(widget))) await box.press('Enter').catch(() => {});
    const next = await firstOf(widget, [PASSWORD_BOX, CODE_BOXES], 15_000);
    if (next === CODE_BOXES) return needsCode();
    if (next === null) {
      const said = await widgetText(widget);
      return {
        outcome: 'failed',
        detail: REFUSED.test(said)
          ? `Apple refused the Apple ID: "${said.match(REFUSED)![0]}".`
          : 'Entered the Apple ID and pressed Continue, but no password box followed.',
      };
    }
  }

  const password = widget.locator(PASSWORD_BOX);
  await password.fill(account.password);
  if (!(await pressContinue(widget))) await password.press('Enter').catch(() => {});
  return awaitOutcome(page, widget);
}

/** Back on the job site, at the code screen, or refused. */
async function awaitOutcome(page: Page, widget: FrameLocator): Promise<AppleAttempt> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(750);
    if (page.isClosed()) return { outcome: 'failed', detail: 'The application tab was closed.' };
    if (!onAppleSignIn(page)) return { outcome: 'signed-in', detail: 'Signed in with your Apple Account.' };
    if (await isVisible(widget, CODE_BOXES)) return needsCode();
    const text = await widgetText(widget);
    if (CODE_SCREEN.test(text)) return needsCode();
    // The password box empties itself and stays up when Apple says no.
    const refused = text.match(REFUSED);
    if (refused) return { outcome: 'failed', detail: `Apple refused the sign-in: "${refused[0]}".` };
  }
  return { outcome: 'failed', detail: 'Submitted the Apple ID and password, but the sign-in page did not move on.' };
}

const needsCode = (): AppleAttempt => ({
  outcome: 'needs-code',
  detail:
    'Apple sent a six-digit code to your iPhone or Mac. Type it in the open browser window and choose ' +
    '"Trust" - later Apple applications then skip the sign-in.',
});

async function pressContinue(widget: FrameLocator): Promise<boolean> {
  const button = widget.locator(CONTINUE);
  // Disabled until the field above it registers the typing.
  for (let i = 0; i < 20; i++) {
    if (await button.isEnabled().catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return button
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
}

/** Whichever of these selectors shows first, or null at the deadline. */
async function firstOf(widget: FrameLocator, selectors: string[], timeout: number): Promise<string | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) if (await isVisible(widget, sel)) return sel;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function isVisible(widget: FrameLocator, selector: string): Promise<boolean> {
  return widget.locator(selector).first().isVisible().catch(() => false);
}

async function widgetText(widget: FrameLocator): Promise<string> {
  return widget
    .locator('body')
    .innerText({ timeout: 2000 })
    .then((t) => t.replace(/\s+/g, ' ').trim())
    .catch(() => '');
}

function hostOf(page: Page): string {
  try {
    return new URL(page.url()).hostname;
  } catch {
    return '';
  }
}
