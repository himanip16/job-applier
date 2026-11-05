import type { Locator, Page } from 'playwright';
import { countryFromText, normalizeLabel, type FormField } from '@ja/shared';
import { OPTION_TIMEOUT_MS } from './common.js';

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
export function showsChosenOption(field: FormField, want: string, shown: string): boolean {
  if (!shown) return false;
  if (showsDialCodeFor(want, shown)) return true;
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
 * A phone country picker that shows "+91 IN" for India, with no options to
 * check it against. Rippling's list is virtualised, so its options are not
 * harvested, and the correct pick read back as "did not hold the value".
 * The ISO code alone is not enough ("in" is a word); it has to sit beside a
 * dial code.
 */
function showsDialCodeFor(want: string, shown: string): boolean {
  const country = countryFromText(want);
  if (!country || !/\+\d{1,4}/.test(shown)) return false;
  return new RegExp(`(^|[^a-z])${country.code.toLowerCase()}([^a-z]|$)`).test(shown);
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

/**
 * An option's words. SmartRecruiters' `spl-*` dropdown items are a
 * role="option" div inside a shadow root whose text arrives through a
 * <slot>, so their innerText is empty and the words are the slot's.
 */
export async function optionText(opt: Locator): Promise<string> {
  return opt
    .evaluate((el) => {
      const own = (el as HTMLElement).innerText?.trim();
      if (own) return own;
      return Array.from(el.querySelectorAll('slot'))
        .flatMap((s) => s.assignedNodes({ flatten: true }))
        .map((n) => (n as HTMLElement).innerText ?? n.textContent ?? '')
        .join(' ')
        .trim();
    })
    .catch(() => '');
}

/**
 * Oracle's `cx-select` lists its options as `[role=gridcell]` rows of a
 * `role=grid` it controls. Only counted inside the control's own list, so no
 * other grid on the page is mistaken for options.
 *
 * Lever's location search draws plain `<div class="dropdown-location">` rows,
 * with no role at all.
 */
const OPTION = '[role="option"]:visible, .select__option:visible, .dropdown-location:visible';
const OWNED_OPTION = `${OPTION}, [role="gridcell"]:visible`;

/**
 * Where a control's options live when the list it names holds none of them.
 *
 * SmartRecruiters' `spl-select` (the phone country code) points aria-controls
 * at a listbox that holds only a `<slot>`; its 240 `spl-select-option`
 * elements are the host's own light children, projected into that slot. A
 * locator under the listbox never reaches them, so every country "could not
 * be found" and the run stopped on the first field of the form. The host is
 * marked and its selector returned; null when the named list is an ordinary one.
 */
export async function controlledListId(input: Locator): Promise<string | null> {
  return input
    .evaluate((el) => {
      // SuccessFactors links its listbox with aria-owns instead of aria-controls.
      // Juspay's sdd dropdowns name it on the role="combobox" wrapper, not the input.
      const own = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
      if (own) return own;
      const wrap = el.parentElement?.closest('[role="combobox"]');
      return wrap?.getAttribute('aria-controls') ?? wrap?.getAttribute('aria-owns') ?? null;
    })
    .catch(() => null);
}

export async function slottedOptionRoot(input: Locator): Promise<string | null> {
  const mark = await input
    .evaluate((el) => {
      const id = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
      if (!id) return null;
      const root = el.getRootNode() as Document | ShadowRoot;
      const list = root.querySelector(`[id="${CSS.escape(id)}"]`) ?? document.getElementById(id);
      if (!list || list.querySelector('[role="option"]') || !list.querySelector('slot')) return null;
      const host = (list.getRootNode() as ShadowRoot).host;
      if (!host) return null;
      const tag = host.getAttribute('data-ja-optroot') ?? `o${Math.random().toString(36).slice(2, 8)}`;
      host.setAttribute('data-ja-optroot', tag);
      return tag;
    })
    .catch(() => null);
  return mark ? `[data-ja-optroot="${mark}"]` : null;
}

export async function waitForOption(page: Page, field: FormField, want: string, offered?: string[]): Promise<Locator | null> {
  // This dropdown's own menu, and only what is visible in it. Greenhouse keeps
  // the phone field's 240-country list in the DOM, hidden, at all times; a
  // page-wide lookup found that first, waited for it to show, and reported
  // every dropdown on the form as "could not find option".
  const input = page.locator(field.selector).first();
  // SuccessFactors links its listbox with aria-owns instead of aria-controls.
  const controls = field.optionContainerSelector ? null : await controlledListId(input);
  const projected = controls ? await slottedOptionRoot(input) : null;
  const container = field.optionContainerSelector
    ? page.locator(field.optionContainerSelector)
    : projected
      ? page.locator(projected)
      : controls
        ? page.locator(`[id="${controls}"]`)
        : page;
  const options = container.locator(controls ? OWNED_OPTION : OPTION);
  try {
    await options.first().waitFor({ state: 'visible', timeout: OPTION_TIMEOUT_MS });
  } catch {
    return null;
  }

  // The first list shown is not always the answer to what was typed. Search-
  // as-you-type lists (Rippling's Location, a places lookup) are still showing
  // the results for "Pat" when the last key lands, and judging that list said
  // "Patna, Bihar, India" was not an option a moment before it appeared. So
  // keep reading until there is a match, or the list has stopped changing.
  const deadline = Date.now() + OPTION_TIMEOUT_MS;
  let last = '';
  let stableReads = 0;
  for (;;) {
    const optionData: { label: string; locator: Locator }[] = [];
    const count = await options.count();
    for (let i = 0; i < count; i++) {
      const opt = options.nth(i);
      const text = normalizeLabel((await optionText(opt)) ?? '');
      if (text) optionData.push({ label: text, locator: opt });
    }

    const matched = bestOption(optionData.map((o) => ({ label: o.label })), want);
    if (matched) {
      return optionData.find((o) => normalizeLabel(o.label) === normalizeLabel(matched.label))?.locator ?? null;
    }

    const seen = optionData.map((o) => o.label).join('|');
    stableReads = seen === last ? stableReads + 1 : 0;
    last = seen;
    // About a second unchanged: this is the list, and the answer is not in it.
    if (stableReads >= 3 || Date.now() > deadline) {
      offered?.push(...optionData.map((o) => o.label));
      return null;
    }
    await page.waitForTimeout(300);
  }
}
