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


# 8. Account wall with no job site password saved: the web app pops up and
#    asks for one. The run waits for it (autopilot included, instead of
#    setting the job aside), and signs in by itself the moment it is saved.
patch('apps/server/src/engine/humanGate.ts', [
    (
        """  blocker: Blocker,
): Promise<boolean> {
  if (blocker.kind !== 'LOGIN_REQUIRED' && blocker.kind !== 'ACCOUNT_CREATION') return false;
  const password = secret('JOB_SITE_PASSWORD');""",
        """  blocker: Blocker,
): Promise<boolean> {
  if (!isAccountWall(blocker)) return false;
  const password = secret('JOB_SITE_PASSWORD');""",
    ),
    (
        """  return !still;
}

export async function pauseForHuman(""",
        """  return !still;
}

const isAccountWall = (blocker: Blocker) =>
  blocker.kind === 'LOGIN_REQUIRED' || blocker.kind === 'ACCOUNT_CREATION';

/**
 * Waiting on the password popup: once a password is saved, sign in with it and
 * carry on without anyone pressing Continue. Never resolves if that sign-in
 * fails - the person finishes it in the browser, and watchForClearance sees it.
 */
function signInOnceSaved(
  applicationId: string,
  page: Page,
  blocker: Blocker,
  stopped: AbortSignal,
): Promise<{ carryOn: boolean; note?: string }> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (stopped.aborted || !secret('JOB_SITE_PASSWORD')) return;
      clearInterval(timer);
      void signInWithSavedAccount(applicationId, page, blocker).then((ok) => {
        if (ok && !stopped.aborted) resolve({ carryOn: true });
      });
    }, 1500);
    stopped.addEventListener('abort', () => clearInterval(timer));
  });
}

export async function pauseForHuman(""",
    ),
    (
        """  if (await signInWithSavedAccount(applicationId, page, blocker)) return true;

  // Park BEFORE announcing, for the same reason as the review gate: a client
  // watching the run can see NEEDS_HUMAN and reply within microseconds, and a
  // reply that arrives before the promise exists is dropped forever.
  if (await isAutopilot(applicationId)) {""",
        """  if (await signInWithSavedAccount(applicationId, page, blocker)) return true;
  // The app asks for the password in a popup; worth waiting for even on
  // autopilot, because every later account wall then clears by itself.
  const askingForPassword = isAccountWall(blocker) && !secret('JOB_SITE_PASSWORD');
  if (askingForPassword) {
    await bus.emitEvent(
      applicationId,
      'LOG',
      'This site wants an account and no job site password is saved - asking you for one.',
    );
  }

  // Park BEFORE announcing, for the same reason as the review gate: a client
  // watching the run can see NEEDS_HUMAN and reply within microseconds, and a
  // reply that arrives before the promise exists is dropped forever.
  if (!askingForPassword && (await isAutopilot(applicationId))) {""",
    ),
    (
        """  let decision: { carryOn: boolean; note?: string };
  try {
    decision = await whileWaitingOnHuman(
      applicationId,
      unlessClosed(
        page,
        Promise.race([manual, watchForClearance(applicationId, page, blocker)]),
        'while waiting for you in the browser',
      ),
    );
  } finally {
    abandon(key);
  }""",
        """  let decision: { carryOn: boolean; note?: string };
  const done = new AbortController();
  const waits = [manual, watchForClearance(applicationId, page, blocker)];
  if (askingForPassword) waits.push(signInOnceSaved(applicationId, page, blocker, done.signal));
  try {
    decision = await whileWaitingOnHuman(
      applicationId,
      unlessClosed(page, Promise.race(waits), 'while waiting for you in the browser'),
    );
  } finally {
    done.abort();
    abandon(key);
  }""",
    ),
])

# 9. "Hide company" on Discover: the web app sends notCompanies, which the
#    server never read, so hidden companies stayed in the list.
patch('apps/server/src/routes/leads.ts', [
    (
        """    company: z.string().optional(),
    tier: z.string().optional(),
    minPay: optionalNumber,""",
        """    company: z.string().optional(),
    // Repeated in the query string, one per company; a single one arrives as a string.
    notCompanies: z.union([z.string(), z.array(z.string())]).optional()
      .transform((v) => (v === undefined ? [] : [v].flat().filter(Boolean))),
    tier: z.string().optional(),
    minPay: optionalNumber,""",
    ),
])
patch('apps/server/src/discovery/leadListing.ts', [
    (
        """  company?: string;
  /** Target-list tier""",
        """  company?: string;
  /** Companies to leave out. */
  notCompanies: string[];
  /** Target-list tier""",
    ),
    (
        """  if (query.company) where.companyName = query.company;
""",
        """  if (query.company) where.companyName = query.company;
  else if (query.notCompanies.length) where.companyName = { notIn: query.notCompanies };
""",
    ),
])

# 9. Email-first account walls ("Log in or create account": an email box and
#    Continue, no password yet - Amazon's job site) count as a login wall, so
#    the saved-account sign-in in .staged/accountWall.ts gets a go at them.
patch('apps/server/src/browser/blockers.ts', [
    (
        """        has(/log ?in to your account/) ||
""",
        """        has(/log ?in to your account/) ||
        has(/(log ?in|sign ?in) or (create|register) (an )?account/) ||
""",
    ),
])

if '--check' in sys.argv:
    print('all matches found')
else:
    # Saving into src/ restarts the server and kills every run in flight.
    import subprocess
    busy = subprocess.run(
        ['pnpm', '--filter', '@ja/server', 'exec', 'tsx', 'src/scripts/applyStaged.ts', '--check'],
        cwd=ROOT,
    ).returncode
    if busy:
        sys.exit('Not patching: runs are live (or the check failed). Try again when nothing is running.')
    for p, s in out:
        open(p, 'w').write(s)
    print('patched')
