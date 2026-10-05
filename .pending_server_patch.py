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

# 6. The run list was not scoped to the signed-in account. Runs page showed
#    another account's NEEDS_HUMAN runs, and "Answer all questions" counted
#    their questions but got 404 opening each one, so the modal was empty.
patch('apps/server/src/routes/applications.ts', [
    (
        """  app.get('/api/applications', async () => {
    const applications = await prisma.application.findMany({
      include:""",
        """  app.get('/api/applications', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const applications = await prisma.application.findMany({
      where: { profileId: profile.id },
      include:""",
    ),
])

# 7. Job site account walls (Workday "Create Account" / "Sign In"): fill them
#    with the profile email and the saved JOB_SITE_PASSWORD before asking the
#    person. Plain DOM work in browser/accountWall.ts - no model sees the page
#    or the password. The password lives in settings, never in profile facts,
#    because facts are pasted into LLM prompts.
patch('apps/server/src/lib/secrets.ts', [
    (
        """  LLM_PROVIDER: {
    label: 'Model provider',""",
        """  JOB_SITE_PASSWORD: {
    label: 'Job site account password',
    help: 'Used with your profile email to create or sign in to job site accounts (Workday and similar).',
    where: '',
    secret: true,
  },
  LLM_PROVIDER: {
    label: 'Model provider',""",
    ),
])
patch('apps/server/src/routes/settings.ts', [
    (
        """    preview: meta.secret ? maskSecret(value) : value,""",
        """    // Not even four characters of a password.
    preview: key === 'JOB_SITE_PASSWORD' ? (value ? '••••' : '') : meta.secret ? maskSecret(value) : value,""",
    ),
    (
        """async function verify(key: SettingKey): Promise<{ ok: boolean; detail: string }> {
  try {""",
        """async function verify(key: SettingKey): Promise<{ ok: boolean; detail: string }> {
  // Nothing to call: it is checked by the first account wall it meets.
  if (key === 'JOB_SITE_PASSWORD') return { ok: true, detail: 'Saved.' };
  try {""",
    ),
])
patch('apps/server/src/engine/humanGate.ts', [
    (
        """import { whileWaitingOnHuman } from './slots.js';
""",
        """import { whileWaitingOnHuman } from './slots.js';
import { secret } from '../lib/secrets.js';
import { signInOrRegister } from '../browser/accountWall.js';
""",
    ),
    (
        """  blocker: Blocker,
): Promise<boolean> {
  // Park BEFORE announcing, for the same reason as the review gate: a client""",
        """  blocker: Blocker,
): Promise<boolean> {
  if (await signInWithSavedAccount(applicationId, page, blocker)) return true;

  // Park BEFORE announcing, for the same reason as the review gate: a client""",
    ),
    (
        """export async function pauseForHuman(""",
        """/**
 * A job site's own account wall, cleared with the saved email and password
 * before anyone is asked. No model is involved; see browser/accountWall.ts.
 * Anything it cannot do - no password saved, a Google sign-in, a refused
 * password - falls through to the ordinary pause.
 */
async function signInWithSavedAccount(
  applicationId: string,
  page: Page,
  blocker: Blocker,
): Promise<boolean> {
  if (blocker.kind !== 'LOGIN_REQUIRED' && blocker.kind !== 'ACCOUNT_CREATION') return false;
  const password = secret('JOB_SITE_PASSWORD');
  if (!password) return false;
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { profile: { select: { email: true } } },
  });
  const email = app?.profile.email;
  if (!email) return false;

  await bus.emitEvent(applicationId, 'LOG', 'Account wall: using your saved email and password.');
  const attempt = await signInOrRegister(page, { email, password }).catch((err: unknown) => ({
    ok: false,
    detail: `Sign-in failed: ${(err as Error).message}`,
  }));
  await bus.emitEvent(applicationId, 'LOG', attempt.detail);
  if (!attempt.ok) return false;
  // An emailed code after registering is the next wall, and the wizard's next
  // step pauses for it; only the account wall itself has to be gone.
  const still = (await detectBlockers(page)).some(
    (b) => b.kind === 'LOGIN_REQUIRED' || b.kind === 'ACCOUNT_CREATION',
  );
  return !still;
}

export async function pauseForHuman(""",
    ),
])

if '--check' in sys.argv:
    print('all matches found')
else:
    for p, s in out:
        open(p, 'w').write(s)
    print('patched')
