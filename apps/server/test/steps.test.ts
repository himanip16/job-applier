import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  detectAutofillPrompt,
  findAdvanceControl,
  looksLikeAGate,
  pageSignature,
  readStepProgress,
  readValidationErrors,
  waitForStepChange,
} from '../src/browser/steps.js';
import { extractFields } from '../src/browser/extract.js';

/**
 * The gap this closes.
 *
 * The engine used to assume one page, one form, one submit. Real applications
 * are wizards: sign in, "shall we autofill from your resume?", then five
 * screens, only the last of which has a Submit button. The fixture is that
 * shape, including the parts that break naive drivers — the URL never changes
 * between steps, one screen has no fields at all, and one rejects you the
 * first time with a message the DOM does not contain.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../../fixtures');

let server: Server;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const name = (req.url ?? '/').replace(/^\//, '').split('?')[0] || 'index.html';
    try {
      const body = await readFile(path.join(fixtures, name));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.close(() => r()));
});

const openAt = async (query = ''): Promise<Page> => {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/workday-like.html${query}`, { waitUntil: 'domcontentloaded' });
  return page;
};

describe('knowing whether anything moved', () => {
  it('gives different steps different signatures, even on one URL', async () => {
    const page = await openAt('?signedin=1');
    const atAutofill = await pageSignature(page);

    await page.click('#do-manual');
    const atStepOne = await pageSignature(page);

    // Same path, different screen. URL comparison alone would call these
    // identical and the driver would think it was stuck.
    expect(new URL(page.url()).pathname).toBe('/workday-like.html');
    expect(atStepOne).not.toBe(atAutofill);
    await page.close();
  }, 60_000);

  it('gives the same signature when a step rejects and re-renders itself', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');
    const before = await pageSignature(page);

    await page.click('.next[data-from="1"]'); // required fields empty
    expect(await waitForStepChange(page, before, 1500)).toBe(false);
    await page.close();
  }, 60_000);
});

describe('reading how far along we are', () => {
  it('reads "Step 1 of 5" and the screen name off the page', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');

    const p = await readStepProgress(page);
    expect(p.index).toBe(1);
    expect(p.total).toBe(5);
    expect(p.label).toBe('My Information');
    await page.close();
  }, 60_000);

  it('comes back empty rather than wrong when the page says nothing', async () => {
    const page = await openAt();
    const p = await readStepProgress(page);
    expect(p.index).toBeNull();
    expect(p.total).toBeNull();
    expect(p.label).toBe('Sign in to apply');
    await page.close();
  }, 60_000);
});

describe('finding the control that moves forward', () => {
  it('calls "Save and Continue" a next, not a submit', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');

    const advance = await findAdvanceControl(page);
    expect(advance).toMatchObject({ kind: 'NEXT', label: 'Save and Continue' });
    await page.close();
  }, 60_000);

  it('only calls it a submit on the screen that really ends the application', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');
    await fillStepsToReview(page);

    const advance = await findAdvanceControl(page);
    expect(advance).toMatchObject({ kind: 'SUBMIT', label: 'Submit' });
    await page.close();
  }, 60_000);

  it('never picks Back, even when it sits right beside Submit', async () => {
    // Getting this wrong walks the wizard backwards forever.
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');
    await fillStepsToReview(page);

    const advance = await findAdvanceControl(page);
    expect(advance!.label).not.toMatch(/back/i);
    await page.close();
  }, 60_000);
});

describe('the autofill question', () => {
  it('finds both answers and can tell them apart', async () => {
    const page = await openAt('?signedin=1');
    const prompt = await detectAutofillPrompt(page);

    expect(prompt).toBeTruthy();
    expect(prompt!.autofillSelector).toBeTruthy();
    expect(prompt!.manualSelector).toBeTruthy();

    await page.click(prompt!.autofillSelector!);
    expect(await page.evaluate(() => document.body.dataset.autofilled)).toBe('yes');
    await page.close();
  }, 60_000);

  it('is not seen on an ordinary form step', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');
    expect(await detectAutofillPrompt(page)).toBeNull();
    await page.close();
  }, 60_000);

  it('leaves parsed values that the profile can beat, for the caller to overwrite', async () => {
    // The fixture parses the phone number wrong on purpose. Autofill is worth
    // taking, and it is exactly why parsed values must not be trusted over
    // the profile.
    const page = await openAt('?signedin=1');
    await page.click('#do-autofill');
    expect(await page.inputValue('#first')).toBe('Himani');
    expect(await page.inputValue('#phone')).toBe('000-000-0000');
    await page.close();
  }, 60_000);
});

describe('a step that will not accept the form', () => {
  it('reports the page own complaint, not "nothing happened"', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');
    await page.click('.next[data-from="1"]');

    const errors = await readValidationErrors(page);
    expect(errors.join(' ')).toMatch(/phone is required/i);
    await page.close();
  }, 60_000);

  it('picks up native constraint messages, which render no markup at all', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');
    await page.fill('#first', 'Himani');
    await page.fill('#last', 'Patel');
    await page.fill('#phone', '415-555-0100');
    await page.click('.next[data-from="1"]');
    await page.waitForTimeout(200);

    // Step 2 wants a file and a number, and says nothing when they are absent.
    await page.click('.next[data-from="2"]');
    const errors = await readValidationErrors(page);
    expect(errors.length).toBeGreaterThan(0);
    await page.close();
  }, 60_000);
});

describe('a screen with nothing to fill', () => {
  it('is recognised as a gate rather than treated as an empty form', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');
    await fillStepsToReview(page);

    // Review has no inputs. Without this the engine would throw "no fields".
    expect(await looksLikeAGate(page)).toBe(true);
    expect(await readStepProgress(page)).toMatchObject({ index: 5, total: 5, label: 'Review' });
    await page.close();
  }, 60_000);

  it('and a step with fields is not', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');
    expect(await looksLikeAGate(page)).toBe(false);
    await page.close();
  }, 60_000);
});

describe('the extractor across steps', () => {
  it('reads each screen separately, and the handles restart each time', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');

    const one = await extractFields(page, { harvestComboboxOptions: false });
    expect(one.map((f) => f.label.toLowerCase()).join(' ')).toMatch(/first name/);

    await page.fill('#first', 'Himani');
    await page.fill('#last', 'Patel');
    await page.fill('#phone', '415-555-0100');
    await page.click('.next[data-from="1"]');
    await page.waitForTimeout(300);

    const two = await extractFields(page, { harvestComboboxOptions: false });
    expect(two.map((f) => f.label.toLowerCase()).join(' ')).toMatch(/resume|years/);
    // The collision the runner has to namespace around: both steps start at f0.
    expect(one[0]!.id).toBe(two[0]!.id);
    await page.close();
  }, 60_000);

  it('reaches the EEO step and marks it sensitive, five screens in', async () => {
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');
    await fillStepsTo(page, 4);

    const fields = await extractFields(page, { harvestComboboxOptions: false });
    const gender = fields.find((f) => /gender/i.test(f.label));
    expect(gender).toBeTruthy();
    expect(gender!.sensitive).toBe(true);
    await page.close();
  }, 60_000);
});

/** Fill steps 1-4 and stop wherever asked (1-indexed screen number). */
async function fillStepsTo(page: Page, stop: number): Promise<void> {
  await page.fill('#first', 'Himani');
  await page.fill('#last', 'Patel');
  await page.fill('#phone', '415-555-0100');
  if (stop === 1) return;
  await page.click('.next[data-from="1"]');
  await page.waitForTimeout(200);

  await page.setInputFiles('#resume', {
    name: 'resume.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 test'),
  });
  await page.fill('#years', '9');
  if (stop === 2) return;
  await page.click('.next[data-from="2"]');
  await page.waitForTimeout(200);

  await page.selectOption('#auth', 'Yes');
  await page.selectOption('#sponsor', 'No');
  if (stop === 3) return;
  await page.click('.next[data-from="3"]');
  await page.waitForTimeout(200);

  await page.selectOption('#gender', 'I do not wish to self-identify');
  if (stop === 4) return;
  await page.click('.next[data-from="4"]');
  await page.waitForTimeout(200);
}

const fillStepsToReview = (page: Page) => fillStepsTo(page, 5);

describe('being handed off to an identity provider', () => {
  it('reads a redirect to accounts.google.com as a login wall', async () => {
    // Checked against the real thing: Google Careers' Apply link redirects to
    // accounts.google.com/v3/signin/identifier, whose first screen is an email
    // box and the words "Use your Google Account". There is no password field
    // to find, so host-based detection is the only thing that catches it.
    const { detectBlockers } = await import('../src/browser/blockers.js');
    const page = await browser.newPage();
    await page.route('**/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Sign in</h1><p>Use your Google Account</p><input type="email" /></body></html>',
      }),
    );
    await page.goto('https://accounts.google.com/v3/signin/identifier?continue=x');

    const blockers = await detectBlockers(page);
    const login = blockers.find((b) => b.kind === 'LOGIN_REQUIRED');
    expect(login).toBeTruthy();
    expect(login!.detail).toMatch(/accounts\.google\.com/);
    expect(login!.humanCanClear).toBe(true);
    await page.close();
  }, 60_000);

  it('does not call an ordinary application page a login wall', async () => {
    const { detectBlockers } = await import('../src/browser/blockers.js');
    const page = await openAt('?signedin=1');
    await page.click('#do-manual');

    const blockers = await detectBlockers(page);
    expect(blockers.find((b) => b.kind === 'LOGIN_REQUIRED')).toBeUndefined();
    await page.close();
  }, 60_000);

  it('stops seeing a wall once the sign-in screen is hidden behind it', async () => {
    // The bug this guards: the fixture keeps its password field mounted after
    // sign-in, exactly as a real single-page application does. Matching on
    // presence rather than visibility left the run stuck at a wall it had
    // already cleared.
    const { detectBlockers } = await import('../src/browser/blockers.js');
    const page = await openAt();

    expect((await detectBlockers(page)).some((b) => b.kind === 'LOGIN_REQUIRED')).toBe(true);
    await page.click('#signin');
    expect(await page.locator('input[type="password"]').count()).toBe(1);
    expect((await detectBlockers(page)).some((b) => b.kind === 'LOGIN_REQUIRED')).toBe(false);
    await page.close();
  }, 60_000);
});

describe('Apply navigates, then redirects again', () => {
  /**
   * The live Google Careers failure, reproduced.
   *
   * A real run against a Google job died with "page.evaluate: Execution
   * context was destroyed, most likely because of a navigation". Its Apply
   * link navigates and the landing page immediately redirects to a sign-in, so
   * the first read of the step loop happened between two navigations.
   */
  it('does not blow up reading a page mid-redirect', async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/redirect-to-signin.html`, { waitUntil: 'domcontentloaded' });

    // Click and read immediately, with no wait at all — the race, deliberately.
    await page.click('a');
    const sig = await pageSignature(page);
    const progress = await readStepProgress(page);

    expect(typeof sig).toBe('string');
    expect(progress).toBeTruthy();
    await page.close();
  }, 60_000);

  it('reports the sign-in as a wall to clear, not as a missing form', async () => {
    // The other half. Before this, openApplicationForm ended the run with
    // "Could not reach an application form on this page." — true, useless, and
    // not resumable. A wall is resumable.
    const { openApplicationForm, NeedsHumanError: NHE } = await import('../src/browser/openForm.js');
    const page = await browser.newPage();

    const err = await openApplicationForm(page, `${baseUrl}/redirect-to-signin.html`).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NHE);
    expect((err as InstanceType<typeof NHE>).kind).toBe('LOGIN_REQUIRED');
    expect((err as Error).message).toMatch(/sign in|signed in/i);
    // And it did follow the Apply link rather than giving up on the job page.
    expect(page.url()).toMatch(/signin-identifier/);
    await page.close();
  }, 60_000);

  it('settles a redirect chain before reading', async () => {
    const { settle } = await import('../src/browser/steps.js');
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/apply-redirect.html`, { waitUntil: 'domcontentloaded' });

    await settle(page);
    expect(page.url()).toMatch(/signin-identifier/);
    expect(await pageSignature(page)).toMatch(/signin-identifier/);
    await page.close();
  }, 60_000);
});

describe('a resume widget is not an autofill prompt', () => {
  /**
   * A real run against a Postman posting on Greenhouse burned all twelve of
   * its steps clicking "Enter manually" — part of the resume field's
   * Attach / Dropbox / Google Drive / Enter manually widget, not an offer to
   * fill the application from a resume.
   */
  it('ignores Greenhouse’s "Enter manually" button', async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/greenhouse-like.html`, { waitUntil: 'domcontentloaded' });

    // The button really is there, so this is not passing by accident.
    expect(await page.locator('#resume-manual').count()).toBe(1);
    expect(await detectAutofillPrompt(page)).toBeNull();
    await page.close();
  }, 60_000);

  it('still sees a real prompt, which offers to do the filling', async () => {
    const page = await openAt('?signedin=1');
    const prompt = await detectAutofillPrompt(page);
    expect(prompt?.autofillSelector).toBeTruthy();
    await page.close();
  }, 60_000);

  it('never reports a prompt with no autofill side', async () => {
    // The guard, stated directly: there is no choice to make unless the site
    // has offered to do the filling.
    const page = await browser.newPage();
    await page.route('**/manual-only', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>Apply</h1><button>Enter manually</button><button>Apply manually</button></body></html>',
      }),
    );
    await page.goto(`${baseUrl}/manual-only`);
    expect(await detectAutofillPrompt(page)).toBeNull();
    await page.close();
  }, 60_000);
});
