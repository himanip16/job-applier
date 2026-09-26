import type { Locator, Page } from 'playwright';
import { normalizeLabel, type FormField } from '@ja/shared';

const FIELD_TIMEOUT_MS = 10_000;
const OPTION_TIMEOUT_MS = 5_000;

export class FillError extends Error {
  constructor(
    message: string,
    readonly field: FormField,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = 'FillError';
  }
}

/**
 * Drive one control to a value, whatever it is made of.
 *
 * Real application forms are not `<input>` and `<select>`. Greenhouse renders
 * every dropdown as a react-select combobox - a text input plus a portalled
 * listbox - so `selectOption` throws on it. Lever uses genuine `<select>`.
 * Workable and Ashby mix both, plus custom radio cards. Each widget therefore
 * gets its own driver, and `verifyFilled` reads the value back afterwards so a
 * silently-ignored fill is caught here rather than discovered after submit.
 */
export async function fillField(page: Page, field: FormField, value: string | string[]): Promise<void> {
  // Check field state before attempting to fill
  const state = await inspectControl(page, field);
  
  // If field is locked and already holds the right value, skip filling
  if (state.locked && state.exists) {
    const wanted = Array.isArray(value) ? value.join(', ') : value;
    if (alreadyHolds(state.current, wanted)) {
      return; // Field is already correctly filled and locked
    }
    // Field is locked but has wrong value - this will be caught by verification
  }
  
  // If field doesn't exist in DOM, we can't fill it
  if (!state.exists) {
    throw new FillError(`Field "${field.label}" not found in DOM`, field, true);
  }

  switch (field.widget) {
    case 'react-select':
      await fillReactSelect(page, field, value);
      break;
    case 'radio-group':
      await fillRadioGroup(page, field, asOne(value, field));
      break;
    case 'checkbox-group':
      await fillCheckboxGroup(page, field, Array.isArray(value) ? value : [value]);
      break;
    case 'button-group':
      await fillButtonGroup(page, field, asOne(value, field));
      break;
    case 'combobox-intl-tel':
      await fillNative(page, field, asOne(value, field));
      break;
    case 'file':
      throw new FillError('File fields must be filled with attachFile()', field, false);
    default:
      await fillNative(page, field, value);
  }
}

/**
 * What state is this control actually in, before we try to drive it?
 *
 * Several applicant tracking systems parse the resume up front, fill the
 * identity fields from it, and then **disable** them so the parse cannot be
 * contradicted. Playwright's `fill` has no way to know that is deliberate: it
 * waits for the element to become editable, retries for the full timeout, and
 * eventually reports a failure on a field that was already correct. A live run
 * against Roku's board spent sixty seconds doing that to First Name, Last Name
 * and Email in turn, and then reported all three as errors.
 *
 * One cheap read tells us to leave them alone.
 */
export interface ControlState {
  /** The site will not let anyone change this. */
  locked: boolean;
  /** What it currently holds, as the page reports it. */
  current: string;
  exists: boolean;
}

export async function inspectControl(page: Page, field: FormField): Promise<ControlState> {
  try {
    const el = page.locator(field.selector).first();
    await el.waitFor({ state: 'attached', timeout: 2_000 });
    return await el.evaluate((node) => {
      const input = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const readOnly = 'readOnly' in input ? Boolean(input.readOnly) : false;
      return {
        locked: Boolean(input.disabled) || readOnly || input.getAttribute('aria-disabled') === 'true',
        current: 'value' in input ? String(input.value ?? '') : (node.textContent ?? '').trim(),
        exists: true,
      };
    });
  } catch {
    return { locked: false, current: '', exists: false };
  }
}

/**
 * Is the value already there, allowing for the site having masked it?
 *
 * Roku's board renders the parsed email as `h**********8@gmail.com`. That is
 * the right address with its middle hidden, and comparing it literally against
 * the profile says the field is wrong when it is exactly right - which would
 * send a perfectly good application to a human for no reason.
 */
export function alreadyHolds(current: string, wanted: string | string[]): boolean {
  const want = Array.isArray(wanted) ? wanted.join(', ') : wanted;
  const a = normalizeLabel(current);
  const b = normalizeLabel(want);
  if (!a || !b) return false;
  if (a === b) return true;

  const masked = current.match(/^(.*?)\*+(.*)$/);
  if (masked) {
    const head = normalizeLabel(masked[1] ?? '');
    const tail = normalizeLabel(masked[2] ?? '');
    // Both ends have to agree, and there has to be something to agree on -
    // otherwise "****" matches everything.
    if ((head || tail) && b.startsWith(head) && b.endsWith(tail)) return true;
  }
  return false;
}

async function fillNative(page: Page, field: FormField, value: string | string[]): Promise<void> {
  const el = page.locator(field.selector).first();
  await el.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });

  const disabled = await el.isDisabled().catch(() => false);
  if (disabled) return;

  const wants = (Array.isArray(value) ? value : [value]).map(normalizeLabel).filter(Boolean);
  if (wants.length) {
    const current = normalizeLabel((await el.inputValue().catch(() => '')) ?? '');
    if (current && wants.every((want) => current.includes(want))) return;
  }

  switch (field.kind) {
    case 'SELECT': {
      const want = asOne(value, field);
      // Try by visible label, then by the best option we can find; both are
      // common, and an exact label match is rarer than it looks.
      //
      // Short timeout on the speculative attempt. It is expected to miss - the
      // fallback below is the one that handles "India" against "India +91" -
      // and letting it wait out the default put 30 seconds on the clock for
      // every such field.
      try {
        await el.selectOption({ label: want }, { timeout: 3_000 });
      } catch {
        const option = bestOption(field.options, want);
        if (!option) throw new FillError(`No option "${want}" on ${field.label}`, field);
        await el.selectOption(option.value);
      }
      break;
    }
    case 'MULTISELECT': {
      const wants = Array.isArray(value) ? value : [value];
      const valuesToSelect: string[] = [];
      for (const want of wants) {
        const option = bestOption(field.options, want);
        if (!option) throw new FillError(`No option "${want}" on ${field.label}`, field);
        valuesToSelect.push(option.value);
      }
      await el.selectOption(valuesToSelect);
      break;
    }
    case 'CHECKBOX': {
      const on = /^(true|yes|1|on|checked)$/i.test(asOne(value, field));
      await el.setChecked(on);
      break;
    }
    default: {
      const text = asOne(value, field);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.fill('');
      // type() rather than fill() so React's onChange fires per keystroke;
      // some forms only validate on keyup and stay in an error state otherwise.
      await el.type(text, { delay: 12 });
      // Press Tab to trigger proper blur behavior instead of synthetic events
      await el.press('Tab').catch(() => {});
    }
  }
}

/**
 * react-select (Greenhouse's board, Ashby, many custom forms).
 * The visible control is a text input with role="combobox"; options render
 * into a menu that may be portalled to document.body, so they are located
 * globally by role rather than inside the field's container.
 */
/**
 * Did the control end up on the option we asked for, even though it does not
 * say so in those words?
 *
 * Greenhouse's phone country field is the case that forced this: ask for
 * "India", and the control afterwards reads `+91`. That is a correct fill
 * reported as a failure, which then routes a perfectly good application to a
 * human for no reason.
 *
 * So: find the option we meant, and accept any read-back that is recognisably
 * part of it - its value, or a fragment of its label such as the dial code.
 */
function showsChosenOption(field: FormField, want: string, shown: string): boolean {
  if (!shown) return false;
  const chosen = bestOption(field.options, want);
  if (!chosen) return false;

  const label = normalizeLabel(chosen.label);
  const value = normalizeLabel(chosen.value);
  if (shown === label || shown === value) return true;
  if (label.includes(shown) && shown.length >= 2) return true;

  // The decoration on its own: "+91" out of "India +91".
  const dial = label.match(/\+\d{1,4}/)?.[0];
  return Boolean(dial && normalizeLabel(dial) === shown);
}

/**
 * The option a human would have picked.
 *
 * An exact label match is the exception, not the rule. Greenhouse's phone
 * country field lists `India +91`, not `India`, so resolving the profile's
 * country to "India" and asking for that label finds nothing and the fill
 * fails on a required field — which was enough to end a whole run.
 *
 * Tiers, most specific first, so "India" can never be satisfied by
 * "British Indian Ocean Territory" while an exact option exists.
 */
export function bestOption(
  options: { label: string; value?: string }[] | undefined,
  want: string,
): { label: string; value: string } | null {
  if (!options?.length) return null;
  const target = normalizeLabel(want);
  if (!target) return null;

  // An option with no explicit value submits its label, which is what the
  // browser does for `<option>Text</option>`.
  const norm = options.map((o) => ({
    o: { label: o.label, value: o.value ?? o.label },
    label: normalizeLabel(o.label),
    value: normalizeLabel(o.value ?? o.label),
  }));

  const exact = norm.find((c) => c.label === target || c.value === target);
  if (exact) return exact.o;

  // "India" against "India +91": the option starts with what we asked for and
  // the rest is a dial code or similar decoration.
  const prefixed = norm.find((c) => c.label.startsWith(`${target} `) || c.label.startsWith(`${target}(`));
  if (prefixed) return prefixed.o;

  // "India +91" against an option labelled "India" - the same case, reversed,
  // which happens when a remembered answer carries the decoration.
  const reverse = norm.find((c) => target.startsWith(`${c.label} `));
  if (reverse) return reverse.o;

  // Word-boundary containment. Deliberately last and deliberately strict about
  // boundaries, so "us" does not select "Belarus".
  const boundary = new RegExp(`(^|[^a-z0-9])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  const contained = norm.find((c) => boundary.test(c.label));
  if (contained) return contained.o;

  /**
   * Hierarchical values, narrowed one level at a time.
   *
   * A profile says "Bengaluru, Karnataka, India" and the board lists
   * "Bengaluru, India" - no tier above matches, and the field fails. Dropping
   * the least significant part and trying again is what a person would do, and
   * it is safe because each attempt still has to satisfy the tiers above:
   * "Bengaluru" is matched as a whole word, never as a fragment.
   */
  const parts = want.split(',').map((p) => p.trim()).filter(Boolean);
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const shorter = parts.slice(0, keep).join(', ');
    const hit = bestOption(options, shorter);
    if (hit) return hit;
  }
  return null;
}

async function fillReactSelect(page: Page, field: FormField, value: string | string[]): Promise<void> {
  const wants = Array.isArray(value) ? value : [value];
  const input = page.locator(field.selector).first();
  await input.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
  await input.scrollIntoViewIfNeeded().catch(() => {});

  for (const want of wants) {
    await input.click({ timeout: FIELD_TIMEOUT_MS });
    // Typing narrows a long list (country pickers run to 240 entries) and also
    // opens the menu when a bare click did not.
    await input.fill('').catch(() => {});
    await input.type(want.slice(0, 40), { delay: 15 });

    const option = await waitForOption(page, field, want);
    if (!option) {
      // Some react-selects filter to nothing on a long string; retry on a
      // shorter prefix before giving up.
      await input.fill('').catch(() => {});
      await input.type(want.split(/[\s,(]/)[0] ?? want, { delay: 15 });
      const retry = await waitForOption(page, field, want);
      if (!retry) throw new FillError(`Could not find option "${want}" for ${field.label}`, field);
      await retry.click();
    } else {
      await option.click();
    }
    await page.waitForTimeout(120);
  }
  // Close the menu so it cannot swallow the next click.
  await page.keyboard.press('Escape').catch(() => {});
}

async function waitForOption(page: Page, field: FormField, want: string): Promise<Locator | null> {
  // This dropdown's own menu, and only what is visible in it. Greenhouse keeps
  // the phone field's 240-country list in the DOM, hidden, at all times; a
  // page-wide lookup found that first, waited for it to show, and reported
  // every dropdown on the form as "could not find option".
  const controls = field.optionContainerSelector
    ? null
    : await page.locator(field.selector).first().getAttribute('aria-controls').catch(() => null);
  const container = field.optionContainerSelector
    ? page.locator(field.optionContainerSelector)
    : controls
      ? page.locator(`[id="${controls}"]`)
      : page;
  const options = container.locator('[role="option"]:visible, .select__option:visible');
  try {
    await options.first().waitFor({ state: 'visible', timeout: OPTION_TIMEOUT_MS });
  } catch {
    return null;
  }

  const count = await options.count();
  const optionData: { label: string; locator: Locator }[] = [];
  
  for (let i = 0; i < count; i++) {
    const opt = options.nth(i);
    const text = normalizeLabel((await opt.innerText().catch(() => '')) ?? '');
    if (text) {
      optionData.push({ label: text, locator: opt });
    }
  }

  // Use the same sophisticated matching logic as bestOption()
  const matched = bestOption(optionData.map(o => ({ label: o.label })), want);
  if (!matched) return null;

  // Find the locator corresponding to the matched option
  const matchedLocator = optionData.find(o => 
    normalizeLabel(o.label) === normalizeLabel(matched.label)
  )?.locator;
  
  return matchedLocator || null;
}

async function fillRadioGroup(page: Page, field: FormField, want: string): Promise<void> {
  const target = normalizeLabel(want);
  const scope = page.locator(field.optionContainerSelector ?? field.selector);
  const radios = scope.locator('input[type="radio"]');
  const count = await radios.count();
  for (let i = 0; i < count; i++) {
    const radio = radios.nth(i);
    if (normalizeLabel(await labelTextFor(page, radio)) === target) {
      await radio.check({ force: true });
      return;
    }
  }
  throw new FillError(`No radio option "${want}" under ${field.label}`, field);
}

/** Yes/no toggles: press the button whose text is the answer. */
async function fillButtonGroup(page: Page, field: FormField, want: string): Promise<void> {
  const target = normalizeLabel(want);
  const buttons = page.locator(field.selector).first().locator(':scope > button[aria-pressed]');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    if (normalizeLabel(await button.innerText()) === target) {
      if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
      return;
    }
  }
  throw new FillError(`No option "${want}" under ${field.label}`, field);
}

async function fillCheckboxGroup(page: Page, field: FormField, wants: string[]): Promise<void> {
  const scope = page.locator(field.optionContainerSelector ?? field.selector);
  const boxes = scope.locator('input[type="checkbox"]');
  const count = await boxes.count();
  const targets = new Set(wants.map(normalizeLabel));
  const foundLabels = new Set<string>();
  
  for (let i = 0; i < count; i++) {
    const box = boxes.nth(i);
    const label = normalizeLabel(await labelTextFor(page, box));
    if (targets.has(label)) {
      await box.check({ force: true });
      foundLabels.add(label);
    } else {
      // Uncheck boxes that aren't in the requested set to ensure exact state
      await box.uncheck({ force: true }).catch(() => {});
    }
  }
  
  if (foundLabels.size !== targets.size) {
    const missing = [...targets].filter(t => !foundLabels.has(t));
    throw new FillError(
      `Missing options for ${field.label}: ${missing.join(', ')}`,
      field,
    );
  }
}

/** Resolve the human-visible text attached to an input. */
async function labelTextFor(page: Page, input: Locator): Promise<string> {
  const aria = await input.getAttribute('aria-label');
  if (aria) return aria;
  const id = await input.getAttribute('id');
  if (id) {
    const byFor = page.locator(`label[for="${cssEscape(id)}"]`);
    if (await byFor.count()) return (await byFor.first().innerText()).trim();
  }
  // Wrapping <label><input/> text </label>
  const wrapped = input.locator('xpath=ancestor::label[1]');
  if (await wrapped.count()) return (await wrapped.first().innerText()).trim();
  const sibling = input.locator('xpath=following-sibling::*[1]');
  if (await sibling.count()) return (await sibling.first().innerText().catch(() => '')).trim();
  return (await input.getAttribute('value')) ?? '';
}

export async function attachFile(page: Page, selector: string, filePath: string): Promise<void> {
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

/**
 * Read the value back. A fill that React discarded, or a dropdown that closed
 * without committing, looks identical to a successful one until you check.
 */
export async function verifyFilled(
  page: Page,
  field: FormField,
  expected: string | string[],
): Promise<{ ok: boolean; actual: string }> {
  const wants = (Array.isArray(expected) ? expected : [expected]).map(normalizeLabel).filter(Boolean);
  if (!wants.length) return { ok: true, actual: '' };

  try {
    if (field.widget === 'react-select') {
      // The chosen value renders as text in the control, not as input.value.
      const shell = page
        .locator(field.selector)
        .first()
        .locator('xpath=ancestor::*[contains(@class,"select-shell") or contains(@class,"select__control")][1]');
      const text = normalizeLabel(await shell.first().innerText().catch(() => ''));
      // A phone country picker shows "+91" for "India +91" once chosen.
      const ok = wants.every((w) => text.includes(w) || showsChosenOption(field, w, text));
      return { ok, actual: text };
    }
    if (field.widget === 'button-group') {
      const pressed = page.locator(field.selector).first().locator(':scope > button[aria-pressed="true"]');
      const labels: string[] = [];
      for (let i = 0; i < (await pressed.count()); i++) labels.push(normalizeLabel(await pressed.nth(i).innerText()));
      return { ok: wants.every((w) => labels.includes(w)), actual: labels.join(', ') };
    }
    if (field.widget === 'radio-group' || field.widget === 'checkbox-group') {
      const scope = page.locator(field.optionContainerSelector ?? field.selector);
      const checked = scope.locator('input:checked');
      const n = await checked.count();
      const labels: string[] = [];
      for (let i = 0; i < n; i++) labels.push(normalizeLabel(await labelTextFor(page, checked.nth(i))));
      return { ok: wants.every((w) => labels.includes(w)), actual: labels.join(', ') };
    }
    const el = page.locator(field.selector).first();
    if (field.kind === 'CHECKBOX') {
      // The input's value is whatever the site set ("1", "on"); what matters is the tick.
      const want = /^(true|yes|1|on|checked)$/i.test(wants[0] ?? '');
      const checked = await el.isChecked().catch(() => false);
      return { ok: checked === want, actual: checked ? 'ticked' : 'not ticked' };
    }
    const actual = normalizeLabel((await el.inputValue().catch(() => '')) || '');
    if (field.kind === 'PHONE' || wants.every((w) => /^[\d\s()+.-]{6,}$/.test(w))) {
      // Sites reformat numbers as you type: "9902583674" becomes "99025 83674".
      const digits = (v: string) => v.replace(/\D/g, '');
      return { ok: wants.every((w) => digits(actual).endsWith(digits(w))), actual };
    }
    if (field.kind === 'SELECT') {
      const selectedText = normalizeLabel(
        await el.locator('option:checked').innerText().catch(() => ''),
      );
      const shown = selectedText || actual;
      const ok =
        wants.every((w) => selectedText.includes(w) || actual.includes(w)) ||
        wants.every((w) => showsChosenOption(field, w, shown));
      return { ok, actual: shown };
    }
    return { ok: wants.every((w) => actual.includes(w)), actual };
  } catch (err) {
    return { ok: false, actual: `verification failed: ${(err as Error).message}` };
  }
}

function asOne(value: string | string[], field: FormField): string {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new FillError(`${field.label} takes one value, got ${value.length}`, field);
    }
    return value[0]!;
  }
  return value;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
