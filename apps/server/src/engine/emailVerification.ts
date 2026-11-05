import type { Page } from 'playwright';
import { prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { secret } from '../lib/secrets.js';
import { clearEmailVerification } from '../browser/emailCode.js';
import type { Blocker } from '../browser/blockers.js';

/**
 * "We emailed you a code": with a Gmail app password saved, fetch it and put
 * it in. False hands over to the ordinary pause - no password, no matching
 * email in time, or a code the site would not take.
 */
export async function enterEmailedCode(applicationId: string, page: Page, blocker: Blocker): Promise<boolean> {
  if (blocker.kind !== 'EMAIL_VERIFICATION') return false;
  const appPassword = secret('EMAIL_APP_PASSWORD');
  if (!appPassword) {
    // Said out loud: a silent fall-through read as the code reader failing.
    await bus.emitEvent(
      applicationId,
      'LOG',
      'No Gmail app password is saved, so the emailed code cannot be read for you. ' +
        'Save one under Settings > Email verification codes and runs enter these codes themselves.',
    );
    return false;
  }
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { profile: { select: { email: true } }, job: { select: { company: true } } },
  });
  const email = app?.profile.email;
  if (!email) return false;

  const log = (line: string) => bus.emitEvent(applicationId, 'LOG', line).then(() => {});
  const result = await clearEmailVerification(page, {
    email,
    appPassword,
    company: app?.job.company,
    log,
  }).catch((err: unknown) => ({ ok: false, detail: `Could not read your inbox: ${(err as Error).message}` }));
  await log(result.ok ? result.detail : `${result.detail} Waiting for you to enter it instead.`);
  return result.ok;
}
