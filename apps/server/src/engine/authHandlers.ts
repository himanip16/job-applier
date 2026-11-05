import type { Page } from 'playwright';
import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { detectBlockers, type Blocker } from '../browser/blockers.js';
import { secret } from '../lib/secrets.js';
import { signInOrRegister } from '../browser/accountWall.js';
import { nationalNumber } from './resolver.js';
import { onAppleSignIn, signInWithAppleId } from '../browser/appleId.js';
import { onMicrosoftSignIn, signInWithMicrosoftAccount } from '../browser/microsoftAccount.js';

/**
 * A job site's own account wall, cleared with the saved email and password
 * before anyone is asked. No model is involved; see browser/accountWall.ts.
 * Anything it cannot do - no password saved, a Google sign-in, a refused
 * password - falls through to the ordinary pause.
 */
const MAX_AUTO_SIGN_INS = 2;
const AUTO_SIGN_IN_WINDOW_MS = 15 * 60_000;
/** Recent automatic sign-ins per application, to stop a sign-in loop. */
const autoSignIns = new Map<string, { tries: number; at: number }>();

const isAccountWall = (blocker: Blocker) =>
  blocker.kind === 'LOGIN_REQUIRED' || blocker.kind === 'ACCOUNT_CREATION';

/**
 * Generic job site account sign-in with saved credentials.
 *
 * Signed in, and the account screen came straight back: Target's Workday
 * went Create Account, Sign In, Sign In... until the run ran out of steps.
 * Another go would do the same, so after a couple it is yours.
 */
export async function signInWithSavedAccount(
  applicationId: string,
  page: Page,
  blocker: Blocker,
): Promise<boolean> {
  if (!isAccountWall(blocker)) return false;
  const password = secret('JOB_SITE_PASSWORD');
  if (!password) return false;
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { profile: { select: { email: true, firstName: true, lastName: true, phone: true, countryCode: true } } },
  });
  const email = app?.profile.email;
  if (!email) return false;
  const last = autoSignIns.get(applicationId);
  const tries = last && Date.now() - last.at < AUTO_SIGN_IN_WINDOW_MS ? last.tries + 1 : 1;
  if (tries > MAX_AUTO_SIGN_INS) {
    await bus.emitEvent(
      applicationId,
      'LOG',
      `Signed in ${MAX_AUTO_SIGN_INS} times already and the account screen keeps coming back, so leaving this one to you.`,
    );
    return false;
  }
  autoSignIns.set(applicationId, { tries, at: Date.now() });

  await bus.emitEvent(applicationId, 'LOG', 'Account wall: using your saved email and password.');
  const { firstName, lastName, phone, countryCode } = app.profile;
  const attempt = await signInOrRegister(page, {
    email,
    password,
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
    phone: phone ? nationalNumber(phone, countryCode) : undefined,
    countryCode: countryCode ?? undefined,
  }).catch((err: unknown) => ({
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

/**
 * Apple Careers' Apple Account sign-in, filled with the saved Apple ID and
 * password; see browser/appleId.ts. True only when it got all the way back to
 * the job site. Apple's six-digit code goes to the person's own devices, so
 * that screen - like no password saved, or a refused one - falls through to
 * the ordinary pause, which carries on by itself once the page leaves Apple.
 */
export async function signInWithSavedAppleId(applicationId: string, page: Page, blocker: Blocker): Promise<boolean> {
  if (blocker.kind !== 'LOGIN_REQUIRED' || !onAppleSignIn(page)) return false;
  const password = secret('APPLE_ID_PASSWORD');
  if (!password) return false;
  let appleId = secret('APPLE_ID');
  if (!appleId) {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { profile: { select: { email: true } } },
    });
    appleId = app?.profile.email ?? '';
  }
  if (!appleId) return false;

  await bus.emitEvent(applicationId, 'LOG', 'Apple Account sign-in: using your saved Apple ID and password.');
  const attempt = await signInWithAppleId(page, { appleId, password }).catch((err: unknown) => ({
    outcome: 'failed' as const,
    detail: `Apple sign-in failed: ${(err as Error).message}`,
  }));
  await bus.emitEvent(applicationId, 'LOG', attempt.detail);
  return attempt.outcome === 'signed-in';
}

/**
 * Microsoft Careers' sign-in modal, cleared with the saved Microsoft account:
 * "Sign in using Microsoft", then email and password on Microsoft's own page;
 * see browser/microsoftAccount.ts. True only when it got back to Microsoft
 * Careers signed in. A code or an Authenticator approval - like no password
 * saved, or a refused one - falls through to the ordinary pause, which carries
 * on by itself once the modal is gone.
 *
 * When no Microsoft password is saved, this now attempts SSO fallback via
 * existing Google/LinkedIn sessions in the persistent profile, or switches to
 * native account creation (handled by the standard account wall handler).
 */
export async function signInWithSavedMicrosoftAccount(applicationId: string, page: Page): Promise<boolean> {
  const password = secret('MICROSOFT_ACCOUNT_PASSWORD');
  let email = secret('MICROSOFT_ACCOUNT');
  if (!email) {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { profile: { select: { email: true } } },
    });
    email = app?.profile.email ?? '';
  }
  if (!email) return false;

  // Try with Microsoft credentials if available, otherwise fallback to SSO/native
  if (password) {
    await bus.emitEvent(applicationId, 'LOG', 'Microsoft Careers sign-in: using your saved Microsoft account.');
    const attempt = await signInWithMicrosoftAccount(page, { email, password }, {
      allowSsoFallback: true,
      allowNativeFallback: false, // Native needs JOB_SITE_PASSWORD, handled separately
    }).catch((err: unknown) => ({
      outcome: 'failed' as const,
      detail: `Microsoft sign-in failed: ${(err as Error).message}`,
    }));
    await bus.emitEvent(applicationId, 'LOG', attempt.detail);
    if (attempt.outcome === 'signed-in') return true;
  } else {
    // No Microsoft password - try SSO fallback first
    await bus.emitEvent(
      applicationId,
      'LOG',
      'No Microsoft account password saved. Checking for existing Google/LinkedIn sessions in the browser profile.',
    );
    const attempt = await signInWithMicrosoftAccount(page, { email, password: '' }, {
      allowSsoFallback: true,
      allowNativeFallback: true,
    }).catch((err: unknown) => ({
      outcome: 'failed' as const,
      detail: `Microsoft sign-in failed: ${(err as Error).message}`,
    }));
    await bus.emitEvent(applicationId, 'LOG', attempt.detail);
    if (attempt.outcome === 'signed-in') return true;
    if (attempt.outcome === 'needs-you') {
      // Switched to native account - let the standard account wall handler take over
      await bus.emitEvent(
        applicationId,
        'LOG',
        'Switched to native account creation. The standard account wall handler will take over.',
      );
      return false;
    }
  }

  return false;
}

export { isAccountWall };
