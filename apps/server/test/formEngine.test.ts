import { createServer, type Server } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { extractFields } from '../src/browser/extract.js';
import { fillField, attachFile, verifyFilled } from '../src/browser/fill.js';
import { detectBlockers, detectSubmissionOutcome } from '../src/browser/blockers.js';

/**
 * These run the real extractor and the real fill engine against local fixtures
 * that reproduce the DOM contracts read off live Greenhouse and Lever forms.
 * No network, no API key, no live job board - but the same code paths that run
 * in production, including the react-select click-type-pick dance that is the
 * most breakable part of the whole system.
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

async function open(fixture: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/${fixture}`, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('Greenhouse-shaped form (react-select comboboxes)', () => {
  it('extracts every control with the right kind, widget and options', async () => {
    const page = await open('greenhouse-like.html');
    const fields = await extractFields(page);
    const byLabel = (needle: string) =>
      fields.find((f) => f.label.toLowerCase().includes(needle.toLowerCase()));

    expect(byLabel('First Name')).toMatchObject({ kind: 'TEXT', required: true });
    expect(byLabel('Email')).toMatchObject({ required: true });
    expect(byLabel('Resume')).toMatchObject({ kind: 'FILE' });

    // The critical case: a dropdown that is NOT a <select>.
    const auth = byLabel('legally authorized to work');
    expect(auth?.widget).toBe('react-select');
    expect(auth?.kind).toBe('SELECT');
    // Options only exist once the menu is opened; the extractor must have
    // opened it to see these.
    expect(auth?.options?.map((o) => o.label)).toEqual(['Yes', 'No']);

    const langs = byLabel('programming languages');
    expect(langs?.kind).toBe('MULTISELECT');
    expect(langs?.options?.map((o) => o.label)).toContain('TypeScript');

    // The captcha textarea must never be offered up as a fillable field.
    expect(fields.some((f) => /recaptcha/i.test(f.label))).toBe(false);

    await page.close();
  }, 60_000);

  it('attaches canonical keys from labels, and marks EEO questions sensitive', async () => {
    const page = await open('greenhouse-like.html');
    const fields = await extractFields(page);

    const find = (needle: string) => fields.find((f) => f.label.toLowerCase().includes(needle));
    expect(find('first name')?.canonicalKey).toBe('identity.first_name');
    expect(find('legally authorized')?.canonicalKey).toBe('work_auth.authorized');
    expect(find('visa sponsorship')?.canonicalKey).toBe('work_auth.sponsorship_required');
    expect(find('salary expectations')?.canonicalKey).toBe('compensation.expectation');
    expect(find('why do you want to join')?.canonicalKey).toBe('essay.why_company');

    const gender = fields.find((f) => f.label.toLowerCase() === 'gender');
    expect(gender?.sensitive).toBe(true);
    expect(gender?.canonicalKey).toBe('eeo.gender');

    await page.close();
  }, 60_000);

  it('fills text, single-select and multi-select, and reads the values back', async () => {
    const page = await open('greenhouse-like.html');
    const fields = await extractFields(page);
    const find = (needle: string) => fields.find((f) => f.label.toLowerCase().includes(needle))!;

    const first = find('first name');
    await fillField(page, first, 'Himani');
    expect((await verifyFilled(page, first, 'Himani')).ok).toBe(true);

    const auth = find('legally authorized');
    await fillField(page, auth, 'Yes');
    const authCheck = await verifyFilled(page, auth, 'Yes');
    expect(authCheck.ok).toBe(true);

    const langs = find('programming languages');
    await fillField(page, langs, ['TypeScript', 'Go']);
    const langCheck = await verifyFilled(page, langs, ['TypeScript', 'Go']);
    expect(langCheck.ok).toBe(true);

    const essay = find('why do you want to join');
    await fillField(page, essay, 'Because the payments platform work maps onto what I already do.');
    expect((await verifyFilled(page, essay, 'Because the payments platform')).ok).toBe(true);

    await page.close();
  }, 90_000);

  it('uploads a resume through a file input hidden behind a styled button', async () => {
    const page = await open('greenhouse-like.html');
    const fields = await extractFields(page);
    const resume = fields.find((f) => f.kind === 'FILE')!;

    const dir = await mkdtemp(path.join(tmpdir(), 'ja-'));
    const file = path.join(dir, 'resume.txt');
    await writeFile(file, 'Himani Patel - Staff Engineer\nGo, Postgres, distributed systems.');

    await attachFile(page, resume.selector, file);
    expect(await page.locator('#resume-name').textContent()).toBe('resume.txt');

    await page.close();
  }, 60_000);

  it('reports reCAPTCHA as a blocker rather than pretending it is not there', async () => {
    const page = await open('greenhouse-like.html');
    // The fixture carries a g-recaptcha-response textarea, exactly as the real
    // board does. Add the widget node the live page renders alongside it.
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.className = 'g-recaptcha';
      document.body.appendChild(d);
    });
    const blockers = await detectBlockers(page);
    expect(blockers.map((b) => b.kind)).toContain('CAPTCHA');
    expect(blockers.find((b) => b.kind === 'CAPTCHA')?.humanCanClear).toBe(true);
    await page.close();
  }, 60_000);

  it('detects a validation failure rather than reporting a phantom success', async () => {
    const page = await open('greenhouse-like.html');
    const before = page.url();
    await page.locator('#application-form button[type="submit"]').click();
    const outcome = await detectSubmissionOutcome(page, before);
    expect(outcome.outcome).toBe('VALIDATION_ERROR');
    expect(outcome.detail).toMatch(/missing required fields/i);
    await page.close();
  }, 60_000);
});

describe('Lever-shaped form (native controls)', () => {
  it('extracts native selects with their options and groups the radios', async () => {
    const page = await open('lever-like.html');
    const fields = await extractFields(page, { harvestComboboxOptions: false });
    const find = (needle: string) => fields.find((f) => f.label.toLowerCase().includes(needle));

    const auth = find('legally authorised');
    expect(auth?.widget).toBe('native');
    expect(auth?.kind).toBe('SELECT');
    // The "Select..." placeholder must be stripped, or we would offer it as a
    // real answer.
    expect(auth?.options?.map((o) => o.label)).toEqual(['Yes', 'No']);
    // British spelling still resolves to the same canonical question.
    expect(auth?.canonicalKey).toBe('work_auth.authorized');

    const notice = find('notice period');
    expect(notice?.canonicalKey).toBe('availability.notice_period');
    expect(notice?.options?.length).toBe(4);

    const pref = fields.find((f) => f.widget === 'radio-group');
    expect(pref?.kind).toBe('RADIO');
    expect(pref?.options?.map((o) => o.label)).toEqual(['Fully remote', 'Hybrid', 'Fully on-site']);
    expect(pref?.optionContainerSelector).toBeTruthy();

    await page.close();
  }, 60_000);

  it('fills a native select, a radio group and text, then submits successfully', async () => {
    const page = await open('lever-like.html');
    const fields = await extractFields(page, { harvestComboboxOptions: false });
    const find = (needle: string) => fields.find((f) => f.label.toLowerCase().includes(needle))!;

    await fillField(page, find('full name'), 'Himani Patel');
    await fillField(page, find('email'), 'himani@example.com');
    await fillField(page, find('phone'), '+44 7700 900123');
    await fillField(page, find('current location'), 'London, United Kingdom');
    await fillField(page, find('linkedin'), 'https://linkedin.com/in/example');

    const auth = find('legally authorised');
    await fillField(page, auth, 'Yes');
    expect((await verifyFilled(page, auth, 'Yes')).ok).toBe(true);

    const notice = find('notice period');
    await fillField(page, notice, '1 month');
    expect((await verifyFilled(page, notice, '1 month')).ok).toBe(true);

    const pref = fields.find((f) => f.widget === 'radio-group')!;
    await fillField(page, pref, 'Hybrid');
    expect((await verifyFilled(page, pref, 'Hybrid')).ok).toBe(true);

    const before = page.url();
    await page.locator('#btn-submit').click();
    const outcome = await detectSubmissionOutcome(page, before);
    expect(outcome.outcome).toBe('SUBMITTED');

    await page.close();
  }, 90_000);
});
