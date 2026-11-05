import type { Locator, Page } from 'playwright';
import { FIELD_TIMEOUT_MS } from './common.js';

export async function attachFile(page: Page, selector: string, filePath: string): Promise<void> {
  // A button that opens an upload dialog rather than a file input
  // (SuccessFactors' "+ Upload a CV"): press it and feed what it opens.
  const target = page.locator(selector).first();
  const isFileInput = await target
    .evaluate((el) => el instanceof HTMLInputElement && el.type === 'file')
    .catch(() => true);
  if (!isFileInput) return uploadThroughOpener(page, target, filePath);

  // Where a site offers a choice of source, take the one that means "a file
  // from this machine". Greenhouse's resume field is Attach / Dropbox /
  // Google Drive / Enter manually, and only the first of those is a thing we
  // can satisfy - the other three want an account we do not have or text we
  // should not be inventing.
  if (await chooseFileUpload(page, filePath)) return;

  const input = page.locator(selector).first();
  await input.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
  // setInputFiles works on inputs hidden behind a styled "Attach" button,
  // which is how every modern ATS renders file upload.
  await input.setInputFiles(filePath);
}

/**
 * Whether the upload box around this file input already shows a file: its
 * name, or a "Successfully Uploaded" card. Workday swaps its drop zone for a
 * file card once a file is in; an empty drop zone means nothing is there.
 */
export async function fileBoxShowsFile(page: Page, selector: string, filename: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .evaluate((el, name) => {
      const box =
        el.closest('[data-automation-id^="formField"], fieldset, .field, .form-group') ??
        el.parentElement?.parentElement?.parentElement ??
        null;
      const text = (box as HTMLElement | null)?.innerText ?? '';
      if (/successfully uploaded/i.test(text)) return true;
      if (box?.querySelector('[data-automation-id="file-upload-successful"], [data-automation-id="file-upload-item"]')) return true;
      return !!name && text.toLowerCase().includes(name.toLowerCase());
    }, filename)
    .catch(() => false);
}

/**
 * Press a control that opens an upload and give it the file: the browser's
 * own file picker if it raises one, otherwise the file box in whatever
 * dialog appeared. Then confirm the dialog and wait out "Uploading...".
 */
async function uploadThroughOpener(page: Page, opener: Locator, filePath: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  await opener.click({ timeout: FIELD_TIMEOUT_MS }).catch(() => opener.dispatchEvent('click'));
  let picker = await chooser;
  if (!picker) {
    // Some dialogs ask for the source first ("Upload from my device").
    const fromDevice = page.getByRole('button', { name: /(upload|choose|select).*(device|computer)|^browse/i }).first();
    if (await fromDevice.isVisible().catch(() => false)) {
      const second = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
      await fromDevice.click().catch(() => {});
      picker = await second;
    }
  }
  if (picker) {
    await picker.setFiles(filePath);
  } else {
    const inDialog = page.locator('[role="dialog"] input[type="file"], .modal input[type="file"], .sfDialogBox input[type="file"]');
    const input = (await inDialog.count().catch(() => 0)) ? inDialog.last() : page.locator('input[type="file"]').last();
    await input.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
    await input.setInputFiles(filePath);
  }
  const confirm = page
    .locator('[role="dialog"], .modal, .sfDialogBox')
    .getByRole('button', { name: /^(upload|ok|done|attach|save|submit)$/i })
    .first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
  await page
    .getByText(/^uploading/i)
    .first()
    .waitFor({ state: 'hidden', timeout: 30_000 })
    .catch(() => {});
  // SuccessFactors then asks whether to keep the profile or overwrite it from
  // the new CV. Unanswered, the dialog sat over PayU's form and every box
  // stayed empty; overwriting would swap the profile for the CV's parse.
  // Keep it - the run fills the form itself.
  const keep = page
    .locator('button, [role="button"], a')
    .filter({ hasText: /^\s*keep current profile\s*$/i })
    .first();
  if (await keep.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)) {
    await keep.click().catch(() => keep.dispatchEvent('click'));
    await keep.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  }
}

/** Controls that mean "upload a file from this computer". */
const ATTACH_TEXT = /^(attach|attach (a )?(file|resume|cv)|upload|upload (a )?(file|resume|cv)|choose file|browse)$/i;

/** The alternatives, which tell us this really is a source picker. */
const OTHER_SOURCE_TEXT = /(dropbox|google drive|onedrive|enter manually|paste|linkedin)/i;

/**
 * Click "Attach" and hand the file to the dialog it opens.
 *
 * Two reasons to prefer this over writing straight to the hidden input when a
 * picker is present. The input may not be mounted until a source is chosen, so
 * there is nothing to write to yet. And going through the site's own control
 * lets its own code run - the bit that records the filename, marks the field
 * satisfied, and clears the "required" error - which setting `.files` behind
 * its back can leave stale.
 *
 * Returns false when there is no picker, so the direct path still handles the
 * ordinary hidden-input case.
 */
async function chooseFileUpload(page: Page, filePath: string): Promise<boolean> {
  const found = await page
    .evaluate(
      ({ attachSrc, otherSrc }) => {
        const ATTACH = new RegExp(attachSrc, 'i');
        const OTHER = new RegExp(otherSrc, 'i');
        const visible = (el: HTMLElement) =>
          typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null;

        const controls = Array.from(
          document.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"], label'),
        ).filter(visible);

        const text = (el: HTMLElement) =>
          ((el as HTMLInputElement).value || el.getAttribute('aria-label') || el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();

        const attach = controls.find((el) => ATTACH.test(text(el)));
        if (!attach) return null;

        // Only treat it as a source picker when there are other sources beside
        // it. A lone "Attach" button next to a plain file input is just the
        // styled label for that input, and clicking it is unnecessary.
        const hasAlternatives = controls.some((el) => OTHER.test(text(el)));
        if (!hasAlternatives) return null;

        document
          .querySelectorAll('[data-ja-attach]')
          .forEach((el) => el.removeAttribute('data-ja-attach'));
        attach.setAttribute('data-ja-attach', '1');
        return '[data-ja-attach="1"]';
      },
      { attachSrc: ATTACH_TEXT.source, otherSrc: OTHER_SOURCE_TEXT.source },
    )
    .catch(() => null);

  if (!found) return false;

  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5_000 }),
      page.click(found),
    ]);
    await chooser.setFiles(filePath);
    return true;
  } catch {
    // No dialog appeared - the button did something else, or the input was
    // already there. Fall through to writing the input directly, which is
    // still the common case.
    return false;
  }
}
