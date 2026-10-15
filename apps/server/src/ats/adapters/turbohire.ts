import type { Page } from 'playwright';
import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { NeedsHumanError, clearInterstitial, openApplicationForm } from '../../browser/openForm.js';
import { settle } from '../../browser/steps.js';

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
 * Signed in, the form behind the button has not been seen in a real run yet
 * (checked live 2026-10-06, signed out only), so this falls back to the
 * generic form reader and always stops for review.
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
    // Optional questions sit behind a link-styled <span>; open them first so
    // they are read with the rest.
    const more = page.getByText(/^show additional fields$/i).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    await page.evaluate(nameControls).catch(() => {});
    return extractFields(page, { harvestComboboxOptions: true });
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    return {
      resume: files.find((f) => /resume|r[eé]sum[eé]|\bcv\b/i.test(fileHint(f))) ?? files[0],
      coverLetter: files.find((f) => /cover/i.test(fileHint(f))),
    };
  },

  async submit(page) {
    const byRole = page.getByRole('button', { name: /^(submit|submit application|apply|apply now)$/i });
    if (await byRole.count()) {
      await byRole.last().click();
      return;
    }
    await page.locator('form button[type="submit"], [role="dialog"] button[type="submit"]').first().click();
  },

  notes: [
    'Needs a TurboHire candidate sign-in (email only). The run pauses at it the first time; the browser profile keeps the session.',
    'The signed-in application form has not been seen yet, so fields are read generically and every run stops for review.',
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
