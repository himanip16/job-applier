"""Server fixes held back while a run is live. Run with --check first."""
import sys

ROOT = '/Users/himani/Documents/projects/job-applier/'
out = []


def patch(name, pairs):
    s = open(ROOT + name).read()
    for old, new in pairs:
        if s.count(old) != 1:
            sys.exit(f'{name}: expected exactly one match for:\n{old}')
        s = s.replace(old, new)
    out.append((ROOT + name, s))


# 1. Workday: stop "Apply Manually" being clicked as the job's Apply button,
#    and hand the autofill choice to the wizard instead of choosing it here.
patch('apps/server/src/browser/openForm.ts', [
    (
        "import { isNavigationRace } from './steps.js';",
        "import { detectAutofillPrompt, isNavigationRace } from './steps.js';",
    ),
    (
        """/** Labels that open an application, in rough order of specificity. */""",
        """/**
 * "Apply Manually" starts with "apply" but is not the job's Apply button: it is
 * one side of the autofill choice the wizard makes (it prefers the resume).
 */
const NOT_THE_APPLY_BUTTON = /manually|autofill|auto-fill|use my last application/i;

/** Labels that open an application, in rough order of specificity. */""",
    ),
    (
        """      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // An Apply link can navigate to a fresh page with its own challenge.
      await clearInterstitial(page).catch((err: unknown) => {
        throw err;
      });
      if (await formReady(page, minInputs, opts.formSelectors, 15_000)) return;""",
        """      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // An Apply link can navigate to a fresh page with its own challenge.
      await clearInterstitial(page).catch((err: unknown) => {
        throw err;
      });
      // Workday's Apply opens "Autofill with Resume / Apply Manually". That is
      // the start of the application, and the wizard decides it - clicking
      // Apply again here picked "Apply Manually" every time.
      if (await detectAutofillPrompt(page)) return;
      if (await formReady(page, minInputs, opts.formSelectors, 15_000)) return;""",
    ),
    (
        """      const control = page.getByRole(role, { name: pattern });
      const count = await control.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 3); i++) {
        const nth = control.nth(i);
        if (!(await nth.isVisible().catch(() => false))) continue;""",
        """      const control = page.getByRole(role, { name: pattern });
      const count = await control.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 3); i++) {
        const nth = control.nth(i);
        if (!(await nth.isVisible().catch(() => false))) continue;
        const name = (await nth.innerText().catch(() => '')) || (await nth.getAttribute('aria-label').catch(() => '')) || '';
        if (NOT_THE_APPLY_BUTTON.test(name)) continue;""",
    ),
])

# 2. Workday's autofill choices can be plain links.
patch('apps/server/src/browser/steps.ts', [
    (
        """      document.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"], label'),""",
        """      document.querySelectorAll<HTMLElement>('button, a[href], a[role="button"], [role="button"], label'),""",
    ),
])

# 3. "Phone Extension" is not the phone number.
patch('packages/shared/src/canonical.ts', [
    (
        """    patterns: [/^phone/i, /mobile\\s*(number|phone)/i, /telephone/i, /contact number/i],""",
        """    patterns: [/^phone(?!\\s*(ext|extension|type|device))/i, /mobile\\s*(number|phone)/i, /telephone(?!\\s*ext)/i, /contact number/i],""",
    ),
])

# 4. A run nobody is waiting on is not "needs human": interrupted auto-apply
#    runs become FAILED (retryable, review on), and on boot any NEEDS_HUMAN run
#    whose browser died with the old process is moved the same way - except
#    where a submit may already have gone through.
patch('apps/server/src/engine/queue.ts', [
    (
        """          status: 'NEEDS_HUMAN',
          requiresReview: true,
          blockedReason:
            app.status === 'SUBMITTING'
              ? 'The server restarted mid-submit. Check the job board before retrying - it may have gone through.'
              : 'Auto-apply was interrupted by a server restart. Review is back on; start it again if you still want it.',""",
        """          status: app.status === 'SUBMITTING' ? 'NEEDS_HUMAN' : 'FAILED',
          requiresReview: true,
          blockedReason:
            app.status === 'SUBMITTING'
              ? 'The server restarted mid-submit. Check the job board before retrying - it may have gone through.'
              : 'Auto-apply was interrupted by a server restart. Review is back on; retry it if you still want it.',""",
    ),
    (
        """export async function recoverInterruptedRuns(): Promise<number> {""",
        """export async function recoverInterruptedRuns(): Promise<number> {
  // Waiting for you at a wall needs the browser page, and that died with the
  // old process. Nothing is waiting any more, so say it stopped - unless a
  // submit may have landed, which a person has to check.
  const orphaned = await prisma.application.findMany({
    where: { status: 'NEEDS_HUMAN' },
    select: { id: true, blockedReason: true },
  });
  for (const app of orphaned) {
    if (/Submit was pressed|mid-submit|may have gone through/i.test(app.blockedReason ?? '')) continue;
    const interrupted = /Auto-apply was interrupted/i.test(app.blockedReason ?? '');
    await prisma.application.update({
      where: { id: app.id },
      data: {
        status: 'FAILED',
        blockedReason: interrupted
          ? 'Auto-apply was interrupted by a server restart. Review is back on; retry it if you still want it.'
          : `Stopped by a server restart while it was waiting for you (${(app.blockedReason ?? 'in the browser').slice(0, 160)}). Retry it.`,
      },
    });
  }
""",
    ),
])

# 5. Workday swaps a text input for a fresh node when it blurs, so the
#    data-ja-field stamp is gone by the time we read the value back. The
#    read-back waited the full 20s default timeout on a missing node, got '',
#    and reported "value did not stick" for every field that had in fact
#    filled correctly.
patch('apps/server/src/browser/fill.ts', [
    (
        """    const el = page.locator(field.selector).first();
    if (field.kind === 'CHECKBOX') {""",
        """    let el = page.locator(field.selector).first();
    // Workday replaces a text input with a new node on blur, and our stamp
    // leaves with the old one. The name attribute survives the swap.
    if (!(await el.count()) && field.name) {
      el = page.locator(`[name="${cssEscape(field.name)}"]`).first();
    }
    if (field.kind === 'CHECKBOX') {""",
    ),
    (
        "const actual = normalizeLabel((await el.inputValue().catch(() => '')) || '');",
        "const actual = normalizeLabel((await el.inputValue({ timeout: 3_000 }).catch(() => '')) || '');",
    ),
])

if '--check' in sys.argv:
    print('all matches found')
else:
    for p, s in out:
        open(p, 'w').write(s)
    print('patched')
