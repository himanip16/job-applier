import type { Locator, Page } from 'playwright';
import { normalizeLabel, type FormField } from '@ja/shared';

const FIELD_TIMEOUT_MS = 10_000;
const OPTION_TIMEOUT_MS = 5_000;

/**
 * Cache for resolved field options to avoid recomputation.
 * Key: JSON string of (options array + wanted value)
 * Value: The resolved option
 */
const optionCache = new Map<string, { label: string; value: string }>();

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
 * Control Driver interface for handling different widget types.
 *
 * This architecture makes it easy to add new widget types by implementing
 * this interface rather than adding special cases throughout the codebase.
 */
export interface ControlDriver {
  name: string;
  canHandle(field: FormField): boolean;
  fill(page: Page, field: FormField, value: string | string[]): Promise<void>;
  read(page: Page, field: FormField): Promise<string[]>;
  matches(actual: string[], expected: string | string[]): boolean;
}

/**
 * React-Select driver (Greenhouse, Ashby, many custom forms).
 */
const reactSelectDriver: ControlDriver = {
  name: 'react-select',
  canHandle: (field) => field.widget === 'react-select',
  fill: async (page, field, value) => {
    const wants = Array.isArray(value) ? value : [value];
    const input = page.locator(field.selector).first();
    await input.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
    await input.scrollIntoViewIfNeeded().catch(() => {});

    for (const want of wants) {
      await input.click({ timeout: FIELD_TIMEOUT_MS });
      await input.fill('').catch(() => {});
      await input.type(want.slice(0, 40), { delay: 15 });

      const option = await waitForOption(page, field, want);
      if (!option) {
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
    await page.keyboard.press('Tab').catch(() => {});
  },
  read: async (page, field) => {
    const shell = page
      .locator(field.selector)
      .first()
      .locator('xpath=ancestor::*[@role="combobox" or contains(@class,"select")][1]');
    const text = normalizeLabel(await shell.first().innerText().catch(() => ''));
    return [text];
  },
  matches: (actual, expected) => {
    const wants = (Array.isArray(expected) ? expected : [expected]).map(normalizeLabel);
    return wants.every((w) => actual.some((a) => normalizeLabel(a).includes(w)));
  },
};

/**
 * Radio group driver.
 */
const radioDriver: ControlDriver = {
  name: 'radio-group',
  canHandle: (field) => field.widget === 'radio-group',
  fill: async (page, field, value) => {
    const target = normalizeLabel(asOne(value, field));
    const scope = field.optionContainerSelector
      ? page.locator(field.optionContainerSelector)
      : page.locator(field.selector).locator('xpath=ancestor::fieldset[1] | xpath=ancestor::*[@role="group" or @role="radiogroup"][1] | xpath=parent::*');

    const radios = scope.locator('input[type="radio"]');
    const count = await radios.count();
    for (let i = 0; i < count; i++) {
      const radio = radios.nth(i);
      if (normalizeLabel(await labelTextFor(page, radio)) === target) {
        await radio.check({ force: true });
        return;
      }
    }
    throw new FillError(`No radio option "${asOne(value, field)}" under ${field.label}`, field);
  },
  read: async (page, field) => {
    const scope = field.optionContainerSelector
      ? page.locator(field.optionContainerSelector)
      : page.locator(field.selector).locator('xpath=ancestor::fieldset[1] | xpath=ancestor::*[@role="group" or @role="radiogroup"][1] | xpath=parent::*');
    const checked = scope.locator('input:checked');
    const labels: string[] = [];
    const count = await checked.count();
    for (let i = 0; i < count; i++) {
      labels.push(await labelTextFor(page, checked.nth(i)));
    }
    return labels;
  },
  matches: (actual, expected) => {
    const wants = (Array.isArray(expected) ? expected : [expected]).map(normalizeLabel);
    return wants.every((w) => actual.some((a) => normalizeLabel(a) === w));
  },
};

/**
 * Checkbox group driver.
 */
const checkboxDriver: ControlDriver = {
  name: 'checkbox-group',
  canHandle: (field) => field.widget === 'checkbox-group',
  fill: async (page, field, value) => {
    const wants = Array.isArray(value) ? value : [value];
    const scope = field.optionContainerSelector
      ? page.locator(field.optionContainerSelector)
      : page.locator(field.selector).locator('xpath=ancestor::fieldset[1] | xpath=ancestor::*[@role="group"][1] | xpath=parent::*');

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
        await box.uncheck({ force: true }).catch(() => {});
      }
    }

    if (foundLabels.size !== targets.size) {
      const missing = Array.from(targets).filter((t) => !foundLabels.has(t));
      throw new FillError(`Missing options for ${field.label}: ${missing.join(', ')}`, field);
    }
  },
  read: async (page, field) => {
    const scope = field.optionContainerSelector
      ? page.locator(field.optionContainerSelector)
      : page.locator(field.selector).locator('xpath=ancestor::fieldset[1] | xpath=ancestor::*[@role="group"][1] | xpath=parent::*');
    const checked = scope.locator('input:checked');
    const labels: string[] = [];
    const count = await checked.count();
    for (let i = 0; i < count; i++) {
      labels.push(await labelTextFor(page, checked.nth(i)));
    }
    return labels;
  },
  matches: (actual, expected) => {
    const wants = (Array.isArray(expected) ? expected : [expected]).map(normalizeLabel);
    const actualNorm = actual.map(normalizeLabel);
    return wants.every((w) => actualNorm.includes(w));
  },
};

/**
 * Native HTML controls driver (input, select, textarea).
 */
const nativeDriver: ControlDriver = {
  name: 'native',
  canHandle: (field) =>
    !['react-select', 'radio-group', 'checkbox-group', 'file'].includes(field.widget),
  fill: async (page, field, value) => {
    const el = page.locator(field.selector).first();
    await el.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });

    const wants = (Array.isArray(value) ? value : [value]).map(normalizeLabel).filter(Boolean);
    if (wants.length) {
      const current = normalizeLabel((await el.inputValue().catch(() => '')) ?? '');
      if (current && wants.every((want) => current.includes(want))) return;
    }

    switch (field.kind) {
      case 'SELECT': {
        const want = asOne(value, field);
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
        await el.type(text, { delay: 12 });
        await el.press('Tab').catch(() => {});
      }
    }
  },
  read: async (page, field) => {
    const el = page.locator(field.selector).first();
    if (field.kind === 'SELECT') {
      const selectedText = normalizeLabel(
        await el.locator('option:checked').innerText().catch(() => ''),
      );
      const actual = normalizeLabel((await el.inputValue().catch(() => '')) || '');
      return [selectedText || actual];
    }
    const value = normalizeLabel((await el.inputValue().catch(() => '')) || '');
    return [value];
  },
  matches: (actual, expected) => {
    const wants = (Array.isArray(expected) ? expected : [expected]).map(normalizeLabel);
    return wants.every((want) => actual.some((act) => alreadyHolds(act, want)));
  },
};

/**
 * Registry of all control drivers.
 */
const drivers: ControlDriver[] = [
  reactSelectDriver,
  radioDriver,
  checkboxDriver,
  nativeDriver,
];

/**
 * Find the appropriate driver for a field.
 */
function findDriver(field: FormField): ControlDriver {
  const driver = drivers.find((d) => d.canHandle(field));
  if (!driver) {
    throw new FillError(`No driver found for field "${field.label}" with widget "${field.widget}"`, field, false);
  }
  return driver;
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

  // If field doesn't exist in DOM, we can't fill it
  if (!state.exists) {
    throw new FillError(`Field "${field.label}" not found in DOM`, field, true);
  }

  // Handle locked fields explicitly - fail immediately if wrong value
  if (state.locked) {
    const wanted = Array.isArray(value) ? value.join(', ') : value;
    if (alreadyHolds(state.current, wanted)) {
      return; // Field is already correctly filled and locked
    }
    // Field is locked but has wrong value - fail immediately and deterministically
    throw new FillError(
      `Field "${field.label}" is locked with value "${state.current}", expected "${wanted}"`,
      field,
      false, // Not recoverable - a locked field with wrong value is a hard blocker
    );
  }

  // Handle file fields separately
  if (field.widget === 'file') {
    throw new FillError('File fields must be filled with attachFile()', field, false);
  }

  // Find the appropriate driver and fill the field
  const driver = findDriver(field);
  await driver.fill(page, field, value);
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
    await el.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
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

/**
 * The option a human would have picked, scored by match quality.
 *
 * An exact label match is the exception, not the rule. Greenhouse's phone
 * country field lists `India +91`, not `India`, so resolving the profile's
 * country to "India" and asking for that label finds nothing and the fill
 * fails on a required field — which was enough to end a whole run.
 *
 * Scoring makes the behavior deterministic based on semantics rather than
 * DOM ordering, so "United States" is chosen over "United States Minor Outlying Islands"
 * when the user wants "United States".
 */
interface ScoredOption {
  option: { label: string; value: string };
  score: number;
}

export function bestOption(
  options: { label: string; value?: string }[] | undefined,
  want: string,
  bypassCache = false,
): { label: string; value: string } | null {
  if (!options?.length) return null;
  const target = normalizeLabel(want);
  if (!target) return null;

  // Check cache first (unless bypassing)
  const cacheKey = JSON.stringify({ options: options.map(o => ({ label: o.label, value: o.value ?? o.label })), want: target });
  if (!bypassCache && optionCache.has(cacheKey)) {
    return optionCache.get(cacheKey)!;
  }

  // An option with no explicit value submits its label, which is what the
  // browser does for `<option>Text</option>`.
  const norm = options.map((o) => ({
    o: { label: o.label, value: o.value ?? o.label },
    label: normalizeLabel(o.label),
    value: normalizeLabel(o.value ?? o.label),
  }));

  // Score all candidates
  const scored: ScoredOption[] = [];

  for (const c of norm) {
    let score = 0;

    // Exact label match: highest priority
    if (c.label === target || c.value === target) {
      score = Math.max(score, c.label === target ? 100 : 95);
    }

    // "India" against "India +91": prefix decoration
    if (c.label.startsWith(`${target} `) || c.label.startsWith(`${target}(`)) {
      score = Math.max(score, 80);
    }

    // "India +91" against "India": reverse prefix (remembered answer with decoration)
    if (target.startsWith(`${c.label} `)) {
      score = Math.max(score, 70);
    }

    // Word-boundary containment: strict matching to avoid "us" matching "Belarus"
    const boundary = new RegExp(`(^|[^a-z0-9])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    if (boundary.test(c.label)) {
      score = Math.max(score, 60);
    }

    if (score > 0) {
      scored.push({ option: c.o, score });
    }
  }

  // Return the highest-scoring option
  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    const result = scored[0]!.option;
    // Store in cache
    optionCache.set(cacheKey, result);
    return result;
  }

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
    const hit = bestOption(options, shorter, bypassCache);
    if (hit) {
      // Cache the hierarchical match as well
      optionCache.set(cacheKey, hit);
      return hit;
    }
  }

  return null;
}

/**
 * Helper function used by react-select driver to wait for and find options.
 */
async function waitForOption(page: Page, field: FormField, want: string): Promise<Locator | null> {
  const container = field.optionContainerSelector
    ? page.locator(field.optionContainerSelector)
    : page;
  const options = container.locator('[role="option"], .select__option');
  try {
    await options.first().waitFor({ state: 'visible', timeout: OPTION_TIMEOUT_MS });
  } catch {
    return null;
  }

  const count = await options.count();

  // Fetch all inner texts in a single batch call to avoid 200+ IPC round-trips
  const texts = await options.allInnerTexts();
  const optionData = texts.map((t, i) => ({
    label: normalizeLabel(t),
    locator: options.nth(i),
  })).filter(o => o.label);

  // Use the same sophisticated matching logic as bestOption()
  const matched = bestOption(optionData.map(o => ({ label: o.label })), want);
  if (!matched) return null;

  // Find the locator corresponding to the matched option
  const matchedLocator = optionData.find(o =>
    normalizeLabel(o.label) === normalizeLabel(matched.label)
  )?.locator;

  return matchedLocator || null;
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
    // Use the driver model for verification
    const driver = findDriver(field);
    const actual = await driver.read(page, field);
    const ok = driver.matches(actual, expected);
    return { ok, actual: actual.join(', ') };
  } catch (err) {
    return { ok: false, actual: `verification failed: ${(err as Error).message}` };
  }
}
