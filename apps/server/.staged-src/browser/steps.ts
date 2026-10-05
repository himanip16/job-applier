import type { Page } from 'playwright';

/**
 * Applications are wizards, not forms.
 *
 * The first version of this engine assumed one page: read the fields, fill
 * them, press submit. Almost no real application works that way. Workday walks
 * you through My Information, My Experience, Application Questions, Voluntary
 * Disclosures, Self Identify and Review before anything is submitted. Taleo and
 * iCIMS want an account first. Greenhouse is one page; SuccessFactors is seven.
 * Several ask, before showing you anything, whether you would like your resume
 * parsed to fill it all in.
 *
 * So the loop has to be: look at what is on screen now, deal with it, find the
 * control that moves forward, press it, and check that something actually
 * changed. This module is the part that answers "what is on screen now" and
 * "what moves forward" - deliberately separate from the runner, because it is
 * all heuristics over other people's markup and it needs to be testable
 * against fixtures without a database.
 */


// ------------------------------------------------------------------ reading

/**
 * Is this the page moving under us, rather than something being wrong?
 *
 * Playwright throws when a `page.evaluate` is in flight across a navigation.
 * Against a wizard that is the normal case, not an error: pressing Continue
 * and then reading the page is exactly the race. Google Careers made this
 * unmissable - its Apply link navigates and then redirects again to
 * accounts.google.com, so the first read of the loop landed in the middle of
 * two navigations and the run died with "Execution context was destroyed".
 */
export function isNavigationRace(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed|frame was detached|Target closed|Most likely the page has been closed|navigating and changing the content/i.test(
    message,
  );
}

/**
 * Let the page finish arriving before reading it.
 *
 * Deliberately forgiving: a load state that never settles is common on pages
 * that poll, and waiting the full timeout for one is better than throwing.
 */
export async function settle(page: Page, timeoutMs = 15_000): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  // A short quiet period catches the second hop of a redirect chain, which is
  // the case that actually bit us.
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
}

/**
 * Read the page, and if it moved while we were reading, settle and read again.
 *
 * One retry, not a loop: a page that is still navigating after settling is a
 * page doing something unusual, and quietly retrying forever would turn that
 * into a hang instead of a message.
 */
async function read<T>(page: Page, what: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await what();
  } catch (err) {
    if (!isNavigationRace(err)) throw err;
    await settle(page);
    try {
      return await what();
    } catch (again) {
      if (!isNavigationRace(again)) throw again;
      return fallback;
    }
  }
}

// ---------------------------------------------------------------- signature

/**
 * A fingerprint of the current step.
 *
 * The single most important safety property of a wizard driver is knowing
 * whether pressing "Continue" did anything. URL alone is not enough - a
 * single-page app keeps the same URL across all six steps - and field count
 * alone is not enough either, since two steps can have four fields each. This
 * combines the path, the visible heading and the set of field labels, which in
 * practice is different on every step and identical when a step rejects you
 * and re-renders itself.
 */
export async function pageSignature(page: Page): Promise<string> {
  return read(page, () => page.evaluate(() => {
    const visible = (el: Element) =>
      typeof (el as HTMLElement).checkVisibility === 'function'
        ? (el as HTMLElement).checkVisibility()
        : (el as HTMLElement).offsetParent !== null;
    // Into open shadow roots too: SmartRecruiters' form is all `spl-*` web
    // components, and a light-DOM query saw no inputs on it at all.
    const deepAll = (sel: string): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const visit = (node: ParentNode) => {
        for (const el of Array.from(node.children)) {
          if (el.matches(sel)) out.push(el as HTMLElement);
          if (el.shadowRoot) visit(el.shadowRoot);
          visit(el);
        }
      };
      visit(document);
      return out;
    };

    const heading = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
      .filter(visible)
      .map((h) => (h.textContent ?? '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .join('|');

    const names = deepAll('input, select, textarea, [role="combobox"]')
      .filter((el) => {
        const type = (el.getAttribute('type') ?? '').toLowerCase();
        if (type === 'hidden') return false;
        // A file input is routinely 0x0 behind a styled button, so it counts
        // as long as it is in the rendered tree.
        return type === 'file' ? visible(el) || el.isConnected : visible(el);
      })
      .map(
        (el) =>
          el.getAttribute('name') ||
          el.getAttribute('id') ||
          el.getAttribute('aria-label') ||
          el.tagName,
      )
      .sort()
      .join(',');

    return `${location.pathname}#${heading}#${names}`;
  }), '');
}

/** Wait until the page looks like a different step, or give up. */
export async function waitForStepChange(
  page: Page,
  before: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    let now: string;
    try {
      now = await pageSignature(page);
    } catch {
      // Mid-navigation the document is swapped out from under us. That is
      // itself evidence something moved; let the next poll read the new page.
      continue;
    }
    if (now !== before) return true;
  }
  return false;
}

// ----------------------------------------------------------------- progress

export interface StepProgress {
  /** 1-based, when the page says. */
  index: number | null;
  total: number | null;
  /** The step's own name, e.g. "My Experience". */
  label: string | null;
}

/**
 * How far through are we?
 *
 * Purely for the human watching. A run that says "step 3 of 6: Application
 * Questions" is legible; one that says "FILLING" for four minutes is not.
 * Everything here is best-effort and all of it is allowed to come back null.
 */
export async function readStepProgress(page: Page): Promise<StepProgress> {
  return read(page, () => page.evaluate(() => {
    const text = (document.body?.innerText ?? '').slice(0, 4000);

    // "Step 2 of 5", "2 of 5", "Page 2/5"
    const m =
      text.match(/\bstep\s+(\d{1,2})\s*(?:of|\/)\s*(\d{1,2})\b/i) ??
      text.match(/\bpage\s+(\d{1,2})\s*(?:of|\/)\s*(\d{1,2})\b/i) ??
      text.match(/\b(\d{1,2})\s*of\s*(\d{1,2})\b/i);

    let index: number | null = m ? Number(m[1]) : null;
    let total: number | null = m ? Number(m[2]) : null;

    // Wizard rails: a list of steps with one marked current.
    if (index === null) {
      const items = Array.from(
        document.querySelectorAll('[aria-current="step"], li[aria-current], [data-automation-id*="progressBar"] li'),
      );
      const all = Array.from(document.querySelectorAll('nav li, ol li, [role="tablist"] [role="tab"]'));
      if (items.length === 1 && all.length > 1) {
        const at = all.indexOf(items[0]!);
        if (at >= 0) {
          index = at + 1;
          total = all.length;
        }
      }
    }

    // The step's own heading, not the page's.
    //
    // Every screen of a wizard sits under a page title - "Senior Backend
    // Engineer" - that never changes, and taking the first heading in the
    // document returns that on every step. The step name is always the more
    // specific heading, so rank by level and take the deepest visible one.
    const visibleEl = (el: Element) =>
      typeof (el as HTMLElement).checkVisibility === 'function'
        ? (el as HTMLElement).checkVisibility()
        : (el as HTMLElement).offsetParent !== null;

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .filter(visibleEl)
      .map((el) => ({
        level: Number(el.getAttribute('aria-level')) || Number(el.tagName.slice(1)) || 1,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((h) => h.text);

    const deepest = headings.reduce<{ level: number; text: string } | null>(
      (best, h) => (best === null || h.level > best.level ? h : best),
      null,
    );
    const label = deepest ? deepest.text.slice(0, 80) : null;

    // A "2 of 5" that is really "2 of 5 results" is worse than no number.
    if (index !== null && total !== null && (index > total || total > 20)) {
      return { index: null, total: null, label };
    }
    return { index, total, label };
  }), { index: null, total: null, label: null });
}

// ------------------------------------------------------------------ advance

export type AdvanceKind = 'NEXT' | 'SUBMIT';

export interface AdvanceControl {
  kind: AdvanceKind;
  selector: string;
  label: string;
}

/**
 * Text that ends the application, as opposed to text that moves it along.
 *
 * The distinction decides whether the human gets a review gate, so it is worth
 * being conservative: anything not clearly final is treated as another step,
 * and an extra "Continue" costs nothing while an unexpected submit is
 * irreversible.
 */
const SUBMIT_TEXT =
  /^(submit|submit application|submit my application|send application|finish and submit|complete application|apply now|submit and finish)$/i;

const NEXT_TEXT =
  /^(next|next step|continue|continue to .{0,30}|save and continue|save & continue|save and next|save & next|proceed|review|review and submit|go to next|start|start application|begin)$/i;

/** Never press these, however prominent they are. */
const AVOID_TEXT =
  /(back|previous|cancel|close|clear|reset|save (for later|draft|as draft)|sign out|log ?out|delete|remove|add another|withdraw|print)/i;

export async function findAdvanceControl(page: Page): Promise<AdvanceControl | null> {
  const found = await read(page, () => page.evaluate(
    ({ submitSrc, nextSrc, avoidSrc }) => {
      const SUBMIT = new RegExp(submitSrc, 'i');
      const NEXT = new RegExp(nextSrc, 'i');
      const AVOID = new RegExp(avoidSrc, 'i');

      const visible = (el: HTMLElement) =>
        typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null;

      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]',
        ),
      ).filter((el) => {
        if (!visible(el)) return false;
        if ((el as HTMLButtonElement).disabled) return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        return true;
      });

      const labelOf = (el: HTMLElement) =>
        (
          (el as HTMLInputElement).value ||
          el.getAttribute('aria-label') ||
          el.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();

      // A stable way to point at the element afterwards. Marking it beats
      // synthesising a selector that may not be unique.
      const mark = (el: HTMLElement, token: string) => {
        el.setAttribute('data-ja-advance', token);
        return `[data-ja-advance="${token}"]`;
      };

      document
        .querySelectorAll('[data-ja-advance]')
        .forEach((el) => el.removeAttribute('data-ja-advance'));

      let submit: { selector: string; label: string } | null = null;
      let next: { selector: string; label: string } | null = null;

      for (const el of candidates) {
        const label = labelOf(el);
        if (!label || label.length > 60) continue;
        if (AVOID.test(label)) continue;

        if (!submit && SUBMIT.test(label)) submit = { selector: mark(el, 'submit'), label };
        else if (!next && NEXT.test(label)) next = { selector: mark(el, 'next'), label };
      }

      // Known automation hooks, when the text did not match. Workday's next
      // button says "Save and Continue" on some tenants and nothing useful on
      // others.
      if (!next && !submit) {
        const byHook = candidates.find((el) =>
          /next|continue/i.test(el.getAttribute('data-automation-id') ?? ''),
        );
        if (byHook) next = { selector: mark(byHook, 'next'), label: labelOf(byHook) || 'Next' };
      }

      if (submit) return { kind: 'SUBMIT' as const, ...submit };
      if (next) return { kind: 'NEXT' as const, ...next };
      return null;
    },
    { submitSrc: SUBMIT_TEXT.source, nextSrc: NEXT_TEXT.source, avoidSrc: AVOID_TEXT.source },
  ), null);

  return found;
}

// ------------------------------------------------------------------ autofill

export interface AutofillPrompt {
  /** Text of the choice, for the log. */
  question: string;
  autofillSelector: string | null;
  manualSelector: string | null;
}

/**
 * "Would you like to autofill with your resume?"
 *
 * Worth handling rather than ignoring: on Workday, declining means typing an
 * entire employment history we do not hold in structured form, and accepting
 * means the employer's own parser reads the candidate's own resume. That is
 * the intended path, not a shortcut.
 *
 * The runner keeps the human in the loop afterwards - parsed values are
 * recorded with their own provenance and never silently outrank the profile.
 */
export async function detectAutofillPrompt(page: Page): Promise<AutofillPrompt | null> {
  return read(page, () => page.evaluate(() => {
    const visible = (el: HTMLElement) =>
      typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null;

    const clickable = Array.from(
      document.querySelectorAll<HTMLElement>('button, a[href], a[role="button"], [role="button"], label'),
    )
      .filter(visible)
      // Workday's progress bar names its first step "Autofill with Resume" in
      // a bare <label>. Clicking it does nothing, and matching it made the
      // engine press it three times on the upload step and then give up. A
      // label only counts when it operates a control.
      .filter((el) => !el.closest('[data-automation-id="progressBar"], [aria-label="Application Progress"]'))
      .filter((el) => el.tagName !== 'LABEL' || !!(el as HTMLLabelElement).control);

    const labelOf = (el: HTMLElement) =>
      ((el as HTMLInputElement).value || el.getAttribute('aria-label') || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();

    const AUTOFILL =
      /(autofill with (my )?(resume|cv)|auto[- ]fill with|use (my )?(resume|cv) to (auto)?fill|apply with (my )?(resume|cv)|upload (resume|cv) to autofill|parse (my )?(resume|cv))/i;
    const MANUAL = /(apply manually|enter manually|fill (it )?out manually|manual entry|enter my information|start from scratch|use my last application)/i;

    let autofill: HTMLElement | null = null;
    let manual: HTMLElement | null = null;
    for (const el of clickable) {
      const text = labelOf(el);
      if (!text || text.length > 80) continue;
      if (!autofill && AUTOFILL.test(text)) autofill = el;
      if (!manual && MANUAL.test(text)) manual = el;
    }

    /**
     * No autofill offered means there is no choice to make.
     *
     * This is the whole guard, and it was missing. Greenhouse's resume field
     * offers "Attach / Dropbox / Google Drive / Enter manually" - a widget for
     * choosing how to supply the resume, not a question about how to fill the
     * application. Matching the lone "Enter manually" made the engine click it
     * on every pass of the loop and get nowhere; a real run against a Postman
     * posting spent all twelve of its steps doing exactly that.
     *
     * A prompt only exists when the site has offered to do the filling.
     */
    if (!autofill) return null;

    document.querySelectorAll('[data-ja-autofill]').forEach((el) => el.removeAttribute('data-ja-autofill'));
    const mark = (el: HTMLElement | null, token: string) => {
      if (!el) return null;
      el.setAttribute('data-ja-autofill', token);
      return `[data-ja-autofill="${token}"]`;
    };

    const question =
      labelOf(autofill ?? manual!) ||
      (document.querySelector('h1, h2')?.textContent ?? '').trim();

    return {
      question: question.slice(0, 120),
      autofillSelector: mark(autofill, 'yes'),
      manualSelector: mark(manual, 'no'),
    };
  }), null);
}

// --------------------------------------------------------------- validation

/**
 * What the page is complaining about.
 *
 * Called when "Continue" did not move us. Without this the run reports "the
 * page did not change", which is true and useless; with it, it reports that
 * the phone number is in the wrong format.
 */
export async function readValidationErrors(page: Page): Promise<string[]> {
  return read(page, () => page.evaluate(() => {
    const visible = (el: Element) =>
      typeof (el as HTMLElement).checkVisibility === 'function'
        ? (el as HTMLElement).checkVisibility()
        : (el as HTMLElement).offsetParent !== null;

    const out = new Set<string>();

    for (const el of Array.from(
      document.querySelectorAll(
        '[role="alert"], [aria-invalid="true"], .error, .error-message, .field-error, [data-automation-id*="error" i], [class*="errorMessage" i]',
      ),
    )) {
      if (!visible(el)) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text && text.length < 300) out.add(text);
    }

    // Native constraint messages, which render no markup at all. Read through
    // open shadow roots, where SmartRecruiters keeps every input.
    const deepAll = (sel: string): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const visit = (node: ParentNode) => {
        for (const el of Array.from(node.children)) {
          if (el.matches(sel)) out.push(el as HTMLElement);
          if (el.shadowRoot) visit(el.shadowRoot);
          visit(el);
        }
      };
      visit(document);
      return out;
    };
    for (const el of deepAll('input, select, textarea') as Array<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >) {
      if (!el.willValidate || el.validity.valid) continue;
      const label =
        el.labels?.[0]?.textContent?.trim() || el.getAttribute('name') || el.getAttribute('id') || 'A field';
      out.add(`${label}: ${el.validationMessage}`);
    }

    return [...out].slice(0, 12);
  }), []);
}

/** Is there anything on this step for us to fill, or is it purely a gate? */
export async function looksLikeAGate(page: Page): Promise<boolean> {
  return read(page, () => page.evaluate(() => {
    const visible = (el: HTMLElement) =>
      typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null;
    // Into open shadow roots too: SmartRecruiters' form is all `spl-*` web
    // components, and a light-DOM query saw no inputs on it at all.
    const deepAll = (sel: string): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const visit = (node: ParentNode) => {
        for (const el of Array.from(node.children)) {
          if (el.matches(sel)) out.push(el as HTMLElement);
          if (el.shadowRoot) visit(el.shadowRoot);
          visit(el);
        }
      };
      visit(document);
      return out;
    };
    const inputs = deepAll('input, select, textarea, [role="combobox"]').filter((el) => {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button') return false;
      // Upload inputs are hidden behind a styled drop zone (Workday's
      // "Autofill with Resume" step has nothing else on it). The input being
      // display:none says nothing; whether its drop zone is shown does.
      if (type === 'file') return visible(el) || (!!el.parentElement && visible(el.parentElement));
      return visible(el);
    });
    return inputs.length === 0;
  }), true);
}
