import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  openApplicationForm,
  clearInterstitial,
  detectInterstitial,
  countFillableInputs,
  NeedsHumanError,
  NoFormError,
  describeDiagnosis,
} from '../src/browser/openForm.js';
import { extractFields } from '../src/browser/extract.js';

/**
 * These reproduce the live Ashby failure.
 *
 * A real run against jobs.ashbyhq.com died with "waiting for locator('form')
 * to be visible" after detecting Cloudflare. Three separate things were wrong,
 * and the fixture reproduces all three: an interstitial that renders instead of
 * the page, an application that only mounts after Apply, and an application
 * with no <form> element at all.
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

const open = () => browser.newPage();

describe('the Ashby failure, reproduced', () => {
  it('waits out the interstitial, clicks Apply, and finds inputs with no <form> in sight', async () => {
    const page = await open();
    await openApplicationForm(page, `${baseUrl}/ashby-like.html?challenge=1200`, {
      applyPatterns: [/apply for this job/i],
    });

    // The thing the old code waited for never becomes visible here — and that
    // is fine, because it was never the right thing to wait for.
    expect(await page.locator('form').count()).toBe(0);
    expect(await countFillableInputs(page)).toBeGreaterThanOrEqual(4);

    await page.close();
  }, 60_000);

  it('does not mistake the interstitial for the page', async () => {
    const page = await open();
    await page.goto(`${baseUrl}/ashby-like.html?stuck=1`, { waitUntil: 'domcontentloaded' });
    expect(await detectInterstitial(page)).toBe('cloudflare');
    // And critically: it is not counted as a form just because it has a widget.
    expect(await countFillableInputs(page)).toBe(0);
    await page.close();
  }, 60_000);

  it('hands over to a human when the challenge will not clear, instead of timing out on a form', async () => {
    const page = await open();
    await page.goto(`${baseUrl}/ashby-like.html?stuck=1`, { waitUntil: 'domcontentloaded' });

    const err = await clearInterstitial(page, 2500).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NeedsHumanError);
    expect((err as InstanceType<typeof NeedsHumanError>).kind).toBe('CAPTCHA');
    // The message has to tell you what to do, not name a locator.
    expect((err as Error).message).toMatch(/solve it in the open browser/i);
    expect((err as Error).message).not.toMatch(/locator/i);

    await page.close();
  }, 60_000);

  it('surfaces the whole failure through openApplicationForm, not just the wait', async () => {
    const page = await open();
    const err = await openApplicationForm(page, `${baseUrl}/ashby-like.html?stuck=1`).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NeedsHumanError);
    await page.close();
  }, 60_000);

  it('the extractor then reads the form-less application correctly', async () => {
    const page = await open();
    await openApplicationForm(page, `${baseUrl}/ashby-like.html?challenge=800`, {
      applyPatterns: [/apply for this job/i],
    });

    const fields = await extractFields(page, { harvestComboboxOptions: false });
    const find = (needle: string) => fields.find((f) => f.label.toLowerCase().includes(needle));

    expect(find('name')).toBeTruthy();
    expect(find('email')).toBeTruthy();
    expect(find('resume')?.kind).toBe('FILE');
    expect(find('notice period')?.canonicalKey).toBe('availability.notice_period');
    expect(find('why contoso')?.kind).toBe('TEXTAREA');

    await page.close();
  }, 60_000);
});

describe('when there is genuinely no form', () => {
  it('explains what it saw instead of naming a locator', async () => {
    const page = await open();
    await page.route('**/empty', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><head><title>Careers</title></head><body><h1>Careers</h1><p>No openings right now.</p></body></html>',
      }),
    );

    const err = await openApplicationForm(page, `${baseUrl}/empty`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoFormError);

    const described = describeDiagnosis((err as InstanceType<typeof NoFormError>).diagnosis);
    expect(described).toMatch(/0 fillable input/);
    expect(described).toMatch(/no <form> tag/);
    expect(described).toMatch(/no apply button or link found/);
    // The page's own text is in there, which is what actually tells you why.
    expect(described).toMatch(/No openings right now/);

    await page.close();
  }, 60_000);
});

describe('pages that need no Apply click', () => {
  it('goes straight through when the form is already on the landing page', async () => {
    const page = await open();
    await openApplicationForm(page, `${baseUrl}/lever-like.html`, {
      formSelectors: ['#application-form'],
    });
    expect(await countFillableInputs(page)).toBeGreaterThan(4);
    await page.close();
  }, 60_000);
});

describe('a captcha armed on a real form', () => {
  it('is not treated as an interstitial', async () => {
    // The Greenhouse fixture carries a g-recaptcha-response field on a fully
    // rendered form. That is the normal case and must not block the run.
    const page: Page = await open();
    await page.goto(`${baseUrl}/greenhouse-like.html`, { waitUntil: 'domcontentloaded' });
    expect(await detectInterstitial(page)).toBeNull();
    await page.close();
  }, 60_000);
});

describe('a decoy widget sharing the page with the real application', () => {
  /**
   * The Roku failure, reproduced. A live run against a company careers page
   * filled a "Join our Talent Community" sidebar sign-up under the
   * candidate's name - First Name, Last Name, Email - and never touched the
   * real application at all. The sidebar's three text inputs were enough to
   * satisfy the old "are there fillable inputs yet" check before Apply was
   * ever clicked, and the real application was already in the page by then,
   * just hidden until that click.
   */
  it('does not settle for a sidebar sign-up that never asked for a resume', async () => {
    const page = await open();
    await openApplicationForm(page, `${baseUrl}/careers-page-with-decoy-widget.html`, {
      applyPatterns: [/^apply$/i],
    });
    // Reaching this point at all means it did not stop at the sidebar - it
    // has a resume field on screen, which the sidebar never offers.
    const hasResumeField = await page.locator('#app-resume').isVisible();
    expect(hasResumeField).toBe(true);
    await page.close();
  }, 60_000);

  it('extracts the application fields, not the sign-up widget’s', async () => {
    const page = await open();
    await openApplicationForm(page, `${baseUrl}/careers-page-with-decoy-widget.html`, {
      applyPatterns: [/^apply$/i],
    });
    const fields = await extractFields(page, { harvestComboboxOptions: false });
    const labels = fields.map((f) => f.label);

    expect(labels).toContain('Phone');
    expect(labels).toContain('LinkedIn Profile');
    expect(fields.some((f) => f.kind === 'FILE')).toBe(true);

    // Both forms carry "First Name" - the point is that the sidebar's own
    // copy does not also appear, doubled up in the same field list.
    expect(labels.filter((l) => l === 'First Name')).toHaveLength(1);
    await page.close();
  }, 60_000);
});

