import type { Locator, Page } from 'playwright';
import { normalizeLabel, type FormField } from '@ja/shared';
import { FIELD_TIMEOUT_MS, FillError, OPTION_TIMEOUT_MS, cssEscape } from './common.js';
import { bestOption, showsChosenOption, waitForOption } from './options.js';

/**
 * Workday's search-and-pick box (`data-uxi-widget-type="selectinput"`): type,
 * press Enter, click the match.
 *
 * Search reaches into trees, so "LinkedIn" finds the leaf under "Social
 * Media" without anyone opening the category. When a click opens a category
 * instead of choosing, look for the answer one level down; past that it is a
 * question for a person, not a guess.
 */
export async function fillWorkdayPrompt(page: Page, field: FormField, saved: string, adding = false): Promise<void> {
  const want = workdayPlain(saved) || saved;
  const input = page.locator(field.selector).first();
  await input.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
  // Adding to a box that already holds picks, the joined selection text says
  // nothing about this one; only the pills that appear after a click do.
  const before = adding ? await workdayChosen(page, field) : [];
  const took = async (option?: string): Promise<boolean> => {
    if (!adding) {
      const shown = await workdaySelection(page, field);
      return workdayShows(want, shown) || (!!option && workdayShows(option, shown));
    }
    const now = await workdayChosen(page, field);
    return workdayHolds(want, now) || (!!option && workdayHolds(option, now) && now.length > before.length);
  };
  if (!adding && (await took())) return;
  // A single pick already made is replaced, not added to: Nasdaq's "How Did
  // You Hear About Us?" came back holding "Other", whose pill sits over the
  // search box, and every click on the box timed out on a required field.
  if (!adding) await clearWorkdayPicks(page, field);
  await input.scrollIntoViewIfNeeded().catch(() => {});

  const searches = [want, want.split(/[\s,(]/)[0] ?? want].filter((s, i, all) => s && all.indexOf(s) === i);
  let seen: string[] = [];
  for (const search of searches) {
    await focusWorkdayInput(input);
    await input.fill('');
    await input.type(search.slice(0, 40), { delay: 15 });
    await input.press('Enter');
    await page.waitForTimeout(400);
    // Some tenants pick a sole exact hit on Enter.
    if (await took()) {
      await page.keyboard.press('Escape').catch(() => {});
      return;
    }
    for (let depth = 0; depth < 2; depth++) {
      // The click that opened the box drew the top-level list; the search
      // results replace it a moment later. Wait for a match, not a list.
      const found = await workdayMatch(page, want);
      seen = found.seen;
      if (!found.option) break;
      await page.locator(`[data-ja-opt="${seen.indexOf(found.option)}"]`).click({ timeout: FIELD_TIMEOUT_MS });
      await page.waitForTimeout(400);
      if (await took(found.option)) {
        await page.keyboard.press('Escape').catch(() => {});
        return;
      }
    }
  }
  // Not every tenant's search reaches into the tree: PayPal's "How Did You
  // Hear About Us?" found nothing for "LinkedIn" twice and the run stopped on
  // a required field. Open each category, as a person would, and look there.
  const browsed = await workdayBrowse(page, field, want, took);
  if (browsed === true) return;
  if (browsed.length) seen = browsed;
  await page.keyboard.press('Escape').catch(() => {});
  throw new FillError(
    `Could not find option "${want}" for ${field.label}${seen.length ? ` (saw: ${seen.slice(0, 8).join(', ')})` : ''}`,
    field,
    true,
    seen,
  );
}

/**
 * Walk a Workday prompt's categories one level down for `want`. True when it
 * was picked; otherwise every option seen on the way, for the error.
 */
async function workdayBrowse(
  page: Page,
  field: FormField,
  want: string,
  took: (option?: string) => Promise<boolean>,
): Promise<true | string[]> {
  const input = page.locator(field.selector).first();
  const reopen = async (): Promise<string[]> => {
    await page.keyboard.press('Escape').catch(() => {});
    await focusWorkdayInput(input).catch(() => {});
    await input.fill('').catch(() => {});
    await page.waitForTimeout(500);
    return workdayOptions(page);
  };
  const top = await reopen();
  const all = [...top];
  const pick = async (labels: string[]): Promise<boolean> => {
    const hit = bestOption(labels.map((label) => ({ label })), want);
    if (!hit) return false;
    await page.locator(`[data-ja-opt="${labels.indexOf(hit.label)}"]`).click({ timeout: FIELD_TIMEOUT_MS });
    await page.waitForTimeout(400);
    return took(hit.label);
  };
  if (await pick(top)) return true;
  // Only categories are opened: clicking a leaf would answer the question.
  // A dozen is past any real source list; past that this is not a tree.
  const categories = (await workdayCategories(page)).slice(0, 12);
  for (const category of categories) {
    const labels = await reopen();
    const at = labels.indexOf(category);
    if (at < 0) continue;
    await page.locator(`[data-ja-opt="${at}"]`).click({ timeout: FIELD_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(500);
    const inside = await workdayOptions(page);
    if (inside.join('|') === labels.join('|')) continue;
    all.push(...inside.filter((l) => !all.includes(l)));
    if (await pick(inside)) return true;
  }
  return all;
}

/**
 * Open a Workday search box. A picked item's pill can lie over the input and
 * take the click; focusing it and pressing ArrowDown opens the list the same way.
 */
async function focusWorkdayInput(input: Locator): Promise<void> {
  try {
    await input.click({ timeout: 3_000 });
  } catch {
    await input.focus({ timeout: FIELD_TIMEOUT_MS });
    await input.press('ArrowDown').catch(() => {});
  }
}

/** Remove the picks in a Workday search box, each by its "x" (or Delete on the pill). */
async function clearWorkdayPicks(page: Page, field: FormField): Promise<void> {
  const box = page
    .locator(field.selector)
    .first()
    .locator('xpath=ancestor::*[@data-automation-id="multiSelectContainer"][1]');
  for (let i = 0; i < 5; i++) {
    const pill = box.locator('[data-automation-id="selectedItem"]').first();
    if (!(await pill.count().catch(() => 0))) return;
    const before = await box.locator('[data-automation-id="selectedItem"]').count();
    await pill
      .locator('[data-automation-id="DELETE_charm"]')
      .click({ timeout: 3_000 })
      .catch(async () => {
        await pill.click({ timeout: 3_000 }).catch(() => {});
        await pill.press('Delete').catch(() => {});
      });
    await page.waitForTimeout(300);
    if ((await box.locator('[data-automation-id="selectedItem"]').count()) >= before) return;
  }
}

/**
 * A Workday search box that takes many picks ("Type to Add Skills"). Each
 * item is searched and picked in turn, beside what is already there. Items
 * Workday's list does not offer are reported after the rest are added, so one
 * unknown skill does not leave the box with none.
 */
export async function fillWorkdayPromptMany(page: Page, field: FormField, saved: string[]): Promise<void> {
  const missed: string[] = [];
  for (const item of saved) {
    const want = workdayPlain(item) || item;
    if (!want.trim()) continue;
    // Compared against the pills one by one: the joined selection text holds
    // "javascript", which would pass for "java".
    if (workdayHolds(want, await workdayChosen(page, field))) continue;
    try {
      await fillWorkdayPrompt(page, field, want, true);
    } catch (err) {
      if (!(err instanceof FillError)) throw err;
      missed.push(want);
    }
  }
  if (missed.length) {
    throw new FillError(`Workday does not offer ${missed.map((m) => `"${m}"`).join(', ')} for ${field.label}`, field);
  }
}

/** Is `want` one of the picked items? "Java" holds as "Java (Programming Language)". */
function workdayHolds(want: string, chosen: string[]): boolean {
  const w = normalizeLabel(want);
  return chosen.some((c) => {
    const n = normalizeLabel(c);
    return n === w || normalizeLabel(c.replace(/\s*\([^)]*\)\s*$/, '')) === w;
  });
}

/** Workday's button dropdown: the button shows the choice; the list opens below. */
export async function fillWorkdayDropdown(page: Page, field: FormField, want: string): Promise<void> {
  const button = page.locator(field.selector).first();
  await button.waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
  if (showsChosenOption(field, want, normalizeLabel(await button.innerText().catch(() => '')))) return;
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click({ timeout: FIELD_TIMEOUT_MS });
  const seen: string[] = [];
  const option = await waitForOption(page, field, want, seen);
  if (!option) {
    await page.keyboard.press('Escape').catch(() => {});
    throw new FillError(
      `Could not find option "${want}" for ${field.label}${seen.length ? ` (saw: ${seen.slice(0, 8).join(', ')})` : ''}`,
      field,
      true,
      seen,
    );
  }
  await option.click();
  await page.waitForTimeout(200);
}

/** Poll the open list until it offers something matching `want`. */
async function workdayMatch(page: Page, want: string): Promise<{ option: string | null; seen: string[] }> {
  const deadline = Date.now() + OPTION_TIMEOUT_MS;
  let seen: string[] = [];
  do {
    seen = await workdayOptions(page);
    const option = bestOption(seen.map((label) => ({ label })), want);
    if (option) return { option: option.label, seen };
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return { option: null, seen };
}

/** The open list's options, stamped so the chosen one can be clicked. */
async function workdayOptions(page: Page): Promise<string[]> {
  const open = '[data-automation-id="promptOption"]:not([data-automation-id="selectedItemList"] *)';
  return page
    .evaluate((sel) => {
      document.querySelectorAll('[data-ja-opt]').forEach((n) => n.removeAttribute('data-ja-opt'));
      const labels: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (!el.checkVisibility()) continue;
        el.setAttribute('data-ja-opt', String(labels.length));
        labels.push((el.getAttribute('data-automation-label') ?? el.innerText).replace(/\s+/g, ' ').trim());
      }
      return labels;
    }, open)
    .catch(() => []);
}

/**
 * The stamped options that open a level below rather than choose: Workday
 * draws a right chevron on them and marks the row as having a popup.
 */
async function workdayCategories(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-ja-opt]'))) {
        const row = el.closest<HTMLElement>('[role="option"], [data-automation-id="menuItem"]') ?? el;
        const opens =
          row.getAttribute('aria-haspopup') === 'true' ||
          !!row.querySelector('[class*="chevron-right"], [data-automation-id="promptIcon"]');
        if (opens) out.push((el.getAttribute('data-automation-label') ?? el.innerText).replace(/\s+/g, ' ').trim());
      }
      return out;
    })
    .catch(() => []);
}

/**
 * What the box has chosen, as Workday tells screen readers: the status the
 * input is described by ("0 items selected" / "1 item selected, LinkedIn"),
 * plus any pills in the box around it.
 */
export async function workdaySelection(page: Page, field: FormField): Promise<string> {
  let input = page.locator(field.selector).first();
  // Workday can redraw the input on selection, dropping our stamp; its id stays.
  if (!(await input.count()) && field.name) input = page.locator(`[id="${cssEscape(field.name)}"]`).first();
  const ids = ((await input.getAttribute('aria-describedby').catch(() => null)) ?? '').split(/\s+/).filter(Boolean);
  const said: string[] = [];
  for (const id of ids) said.push(...(await page.locator(`[id="${cssEscape(id)}"]`).allTextContents().catch(() => [])));
  said.push(
    ...(await input
      .locator('xpath=ancestor::*[@data-automation-id="multiSelectContainer"][1]')
      .locator('[data-automation-id="selectedItem"]')
      .allTextContents()
      .catch(() => [] as string[])),
  );
  return normalizeLabel(said.join(' '));
}

/** The items picked in a Workday search box, as drawn, once each. */
export async function workdayChosen(page: Page, field: FormField): Promise<string[]> {
  let input = page.locator(field.selector).first();
  if (!(await input.count()) && field.name) input = page.locator(`[id="${cssEscape(field.name)}"]`).first();
  const items = await input
    .locator('xpath=ancestor::*[@data-automation-id="multiSelectContainer"][1]')
    .locator('[data-automation-id="selectedItem"]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  return [...new Set(items.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

/**
 * A Workday selection without the screen reader's words around it:
 * "expanded 1 item selected electronics electronics" is "electronics". Also
 * cleans answers saved in that shape before the fix, so they still replay.
 */
export function workdayPlain(text: string): string {
  let s = text.replace(/^\s*(expanded|collapsed)\b\s*/i, '').trim();
  const counted = /^\d+ items? selected\b/i.test(s);
  s = s.replace(/^\d+ items? selected\b\s*/i, '').trim();
  // The count is followed by the item twice (drawn, then announced); only
  // then is a doubled phrase an echo rather than a name like "New York New York".
  const words = s.split(/\s+/);
  const half = words.length / 2;
  if (counted && words.length % 2 === 0 && words.slice(0, half).join(' ').toLowerCase() === words.slice(half).join(' ').toLowerCase()) {
    s = words.slice(0, half).join(' ');
  }
  return s;
}

export function workdayShows(want: string, shown: string): boolean {
  const w = normalizeLabel(want);
  if (!w || !shown || /^0 items? selected/.test(shown)) return false;
  return shown.includes(w);
}
