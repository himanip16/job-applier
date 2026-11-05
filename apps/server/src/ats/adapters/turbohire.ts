import type { Page } from 'playwright';
import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { NeedsHumanError, clearInterstitial, openApplicationForm } from '../../browser/openForm.js';
import { settle } from '../../browser/steps.js';
import { dayMonthYearHint } from '../../engine/repeatableSections.js';

/**
 * TurboHire (app.turbohire.co/job/publicjobs/<token>).
 *
 * A Material-UI single-page app; class names (`jss310`) and `data_testid`
 * hashes are build output and mean nothing. The one stable handle is the
 * Apply control: `<button id="Apply-v2" test-id="apply-job-v2">`, rendered
 * twice (header and footer).
 *
 * Applying needs a candidate account. Signed out, that button reads "Sign in
 * to apply" and opens a modal that asks for an email address only - no
 * Google/Microsoft/LinkedIn option, so the run cannot sign in by itself. We
 * open that modal so the sign-in box is what the person sees, and park at the
 * wall. The browser profile keeps the session for later TurboHire jobs.
 *
 * Signed in (IDfy, 2026-10-17), "Show additional fields" opens an
 * "Additional Fields" drawer: addresses, date of birth, marital status,
 * father's name, then Education ("Institute 01", ...) and Experience
 * ("Company 01", ...) rows, each block with an "Add New Entry" button, and a
 * Save button (`test-id="set-btn-save"`) the drawer needs before it keeps
 * anything. TurboHire pre-fills the rows from the resume it parsed, a blank
 * junk row among them. `tagDrawer` names those rows for the shared row
 * handling, so each is filled from the matching saved entry. Everything else
 * is read generically and every run stops for review.
 */
export const turboHireAdapter: AtsAdapter = {
  id: 'turbohire',

  matches(url) {
    return /^https?:\/\/([^/]+\.)?turbohire\.co\//i.test(url);
  },

  async openApplicationForm(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page);
    await clearInterstitial(page);

    // The SPA renders the shell first and the posting a few seconds later.
    const apply = page.locator(APPLY_BUTTON).first();
    const shown = await apply
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    // Not the posting page (an /apply URL, a form already open): let the
    // generic opener look for fields and walls.
    if (!shown) {
      await openApplicationForm(page, url, { applyPatterns: [/^apply( now)?$/i] });
      return;
    }

    if (await isSignedOut(page)) {
      await apply.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1000);
      throw new NeedsHumanError(
        'TurboHire needs a candidate sign-in before it takes applications. In the open browser, ' +
          'enter your email in the "Sign in to apply" box and finish the sign-in (it may email you a ' +
          'code), then press Continue. The browser profile keeps you signed in for later TurboHire jobs.',
        'LOGIN_REQUIRED',
      );
    }

    await apply.click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await settle(page);
    // The button may open a dialog or a new route; wait for its fields in
    // place, since reloading would lose a dialog.
    await waitForForm(page);
    // The wizard looks for Education/Experience rows before it reads the
    // form, so the drawer has to be open and tagged by then.
    await openAdditionalFields(page);
  },

  async readJobMeta(page): Promise<JobMeta> {
    await page.locator('h4').first().waitFor({ timeout: 15_000 }).catch(() => {});
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const h4 = document.querySelector('h4');
      const ogTitle = clean(document.querySelector('meta[property="og:title"]')?.getAttribute('content'));

      // The header block holds title, job code, location, "N position(s)" and
      // the expiry. Location is the leaf that is none of the others.
      let header: Element | null = h4;
      while (header && !/position/i.test(header.textContent ?? '') && header !== document.body) {
        header = header.parentElement;
      }
      const leaves = header
        ? Array.from(header.querySelectorAll('span, p, h6')).filter((e) => e.children.length === 0)
        : [];
      const where = leaves
        .map((e) => clean(e.textContent))
        .find((t) => t.includes(',') && !/job code|position|expires|apply/i.test(t));

      // innerText, not textContent: the description carries an inline <style>
      // and its list items run together without the line breaks.
      const block = (s: string | null | undefined) =>
        (s ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      // "Job Description" is a <p> heading; the text is its next sibling.
      const heading = Array.from(document.querySelectorAll('p, h5, h6')).find(
        (e) => clean(e.textContent) === 'Job Description',
      );
      // "About Company" is an <h6> nested a few boxes below its card.
      let about: HTMLElement | null =
        Array.from(document.querySelectorAll<HTMLElement>('h6')).find(
          (e) => clean(e.textContent) === 'About Company',
        ) ?? null;
      while (about && about.innerText.trim().length < 80) about = about.parentElement;

      return {
        title: clean(h4?.textContent) || ogTitle.replace(/^\[hiring for\]:\s*/i, '') || 'Unknown role',
        // The tab title is the hiring company's name ("IDfy").
        company: clean(document.title) || 'Unknown',
        location: where || undefined,
        descriptionText: [(heading?.nextElementSibling as HTMLElement | null)?.innerText, about?.innerText]
          .map(block)
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 30000) || clean(document.body?.textContent).slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    await openAdditionalFields(page);
    await page.evaluate(nameControls).catch(() => {});
    const fields = await extractFields(page, { harvestComboboxOptions: true });
    // The row date boxes take a whole DD/MM/YYYY date (DD-MM-YYYY for
    // "Passed on"); without saying so, a start date went in as "Oct 2025" or
    // was left blank, and "Passed on" got a bare "2021".
    const formats = await page
      .evaluate(
        (selectors) => selectors.map((sel) => document.querySelector(sel)?.getAttribute('data-ja-date') ?? null),
        fields.map((f) => f.selector),
      )
      .catch(() => fields.map(() => null));
    return fields.map((f, i) => {
      const sep = formats[i];
      if (sep !== '/' && sep !== '-') return f;
      return { ...f, helpText: [f.helpText, dayMonthYearHint(sep)].filter(Boolean).join(' ') };
    });
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    return {
      resume: files.find((f) => /resume|r[eé]sum[eé]|\bcv\b/i.test(fileHint(f))) ?? files[0],
      coverLetter: files.find((f) => /cover/i.test(fileHint(f))),
    };
  },

  async submit(page) {
    // The Additional Fields drawer keeps nothing until its own Save.
    const save = page.locator('[test-id="set-btn-save"]').first();
    if (await save.isVisible().catch(() => false)) {
      await save.click({ timeout: 8000 });
      await page.waitForTimeout(1000);
    }
    const byRole = page.getByRole('button', { name: /^(submit|submit application|apply|apply now)$/i });
    if (await byRole.count()) {
      await byRole.last().click();
      return;
    }
    await page.locator('form button[type="submit"], [role="dialog"] button[type="submit"]').first().click();
  },

  notes: [
    'Needs a TurboHire candidate sign-in (email only). The run pauses at it the first time; the browser profile keeps the session.',
    'The Additional Fields drawer is filled row by row from your saved education and employment; every run stops for review.',
  ],
  alwaysReview: true,
};

/**
 * Give every control the caption a person sees, as aria-label.
 *
 * TurboHire's captions are bare `<span>`s - no <label>, no `for`, no aria, no
 * "label" class - so the shared reader found no name for any of them and
 * dropped every field: Last Name went out blank and the required privacy
 * box unticked (live run, 2026-10-06). The caption for a text box is the
 * nearest text *before* it in its field block; for a checkbox it is the
 * text *after* it ("I have read and understood ... Privacy Policy*").
 *
 * The dial-code picker beside Phone Number is left unnamed on purpose: it
 * defaults to the account's country and would otherwise read as a second
 * question called "Phone Number".
 *
 * Runs in the page, so it must be self-contained.
 */
function nameControls(): void {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const hasControl = (n: Element) => !!n.querySelector('input, textarea, select, button');
  const textOfNode = (n: Element) => (hasControl(n) ? '' : clean(n.textContent));

  /** Walk up; at each level read the siblings on one side of our branch. */
  const captionNear = (el: Element, side: 'before' | 'after'): string => {
    let child: Element = el;
    for (let depth = 0; depth < 8 && child.parentElement; depth++) {
      const parent: Element = child.parentElement;
      const kids = Array.from(parent.children);
      const at = kids.indexOf(child);
      const run = side === 'before' ? kids.slice(0, at).reverse() : kids.slice(at + 1);
      for (const k of run) {
        if (k.tagName === 'STYLE' || k.tagName === 'SVG' || k.tagName === 'svg') continue;
        // A sibling holding a control is another field (or the dial-code
        // picker beside Phone Number); its caption is not ours.
        const t = textOfNode(k);
        if (t) return t;
      }
      child = parent;
    }
    return '';
  };

  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([type=file]), textarea, select'),
  )) {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) continue;
    const isCheck = el.getAttribute('type') === 'checkbox' || el.getAttribute('type') === 'radio';
    const caption = captionNear(el, isCheck ? 'after' : 'before');
    if (!caption) continue;
    if (el.closest('[role="combobox"]') && /phone/i.test(caption)) continue;
    const required = /[*✱]\s*$/.test(caption) || /\*\s/.test(caption);
    el.setAttribute('aria-label', caption.replace(/\s*\*+\s*$/, '').replace(/\*/g, '').trim());
    if (required && !el.hasAttribute('disabled')) el.setAttribute('aria-required', 'true');
  }
}

/** Open the optional questions (a link-styled <span>) and tag what is in them. */
async function openAdditionalFields(page: Page): Promise<void> {
  const more = page.getByText(/^show additional fields$/i).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.evaluate(tagDrawer).catch(() => {});
}

/**
 * Mark the drawer's repeat rows and date boxes for the shared handling.
 *
 * - A row is headed by an <h6> "Company 01" / "Institute 01"; its container
 *   gets `data-ja-rows`, as Oracle's do.
 * - Each block's "Add New Entry" sits in `[test-id="create-candidate-
 *   {experience,education}-entry"]`; Education's is outside the rows' own
 *   container, so it is tagged `data-ja-add` instead.
 * - Row date boxes get `data-ja-date` with their separator. Start/End Date
 *   show no placeholder; the drawer's other date boxes use DD/MM/YYYY.
 * - "University" beside "Institute Name" is the affiliating university, not
 *   the school again.
 *
 * Runs in the page, so it must be self-contained.
 */
function tagDrawer(): void {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  for (const h of Array.from(document.querySelectorAll('h6'))) {
    const t = clean(h.textContent);
    const kind = /^company \d+$/i.test(t) ? 'employment' : /^institute \d+$/i.test(t) ? 'education' : null;
    if (!kind) continue;
    let row: Element | null = h.parentElement;
    while (row && !row.querySelector('input')) row = row.parentElement;
    row?.parentElement?.setAttribute('data-ja-rows', kind);
  }
  for (const [kind, id] of [
    ['employment', 'experience'],
    ['education', 'education'],
  ] as const) {
    document.querySelector(`[test-id="create-candidate-${id}-entry"] button`)?.setAttribute('data-ja-add', kind);
  }
  for (const input of Array.from(
    document.querySelectorAll<HTMLInputElement>(
      '[test-id="create-candidate-startdate"] input, [test-id="create-candidate-enddate"] input, ' +
        '[test-id="create-candidate-education-pass"] input',
    ),
  )) {
    const sep = /^DD([/-])MM\1YYYY$/i.exec(input.placeholder.trim())?.[1] ?? '/';
    input.setAttribute('data-ja-date', sep);
  }
  for (const input of Array.from(
    document.querySelectorAll<HTMLInputElement>('[test-id="create-candidate-university"] input'),
  )) {
    input.setAttribute('aria-label', 'Affiliating university');
  }
}

/** The posting's Apply control, header and footer copies alike. */
const APPLY_BUTTON = '#Apply-v2, [test-id="apply-job-v2"]';

async function isSignedOut(page: Page): Promise<boolean> {
  const label = await page.locator(APPLY_BUTTON).first().innerText().catch(() => '');
  return /sign ?in|log ?in/i.test(label);
}

/**
 * Wait for what the Apply click opened to become fillable, without reloading.
 *
 * Mirrors the tail of the generic opener: fields, or a wall to park at, or a
 * clear failure - never a silent timeout.
 */
async function waitForForm(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const visible = await page
      .locator('input:not([type=hidden]), textarea, select, [role="combobox"]')
      .evaluateAll((els) =>
        els.filter((el) => {
          if ((el as HTMLInputElement).type === 'file') return true;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).length,
      )
      .catch(() => 0);
    if (visible >= 2) return;
    await page.waitForTimeout(500);
  }
  // Nothing fillable appeared. Hand over to the generic opener on the
  // current URL: it re-reads the page, tries an Apply control by name, and
  // turns a sign-in or verification screen into a pause instead of a failure.
  await openApplicationForm(page, page.url(), { applyPatterns: [/^apply( now)?$/i] });
}
