import type { Page } from 'playwright';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { bus } from '../lib/events.js';
import { newPage, screenshot } from '../browser/session.js';
import { NeedsHumanError } from '../browser/openForm.js';
import { adapterFor } from '../ats/registry.js';
import { handleOpenFailure, pauseForHuman } from './humanGate.js';
import { artifact, setStatus } from './runLog.js';
import { walkApplication } from './wizard.js';
import { finishApplication } from './submission.js';
import { abandon, release, questionsKey, reviewKey, blockerKey } from './waiters.js';

export { SubmissionBudgetError } from './submission.js';

/**
 * Drive one application end to end.
 *
 * Four stages, and the whole point of this file is that they read in order:
 *
 *   1. reach the form            - which can itself hit a sign-in wall
 *   2. read the posting
 *   3. walk the application      - see wizard.ts, the bulk of the work
 *   4. review and submit         - see submission.ts, the irreversible part
 *
 * The run parks rather than exits at every point where it needs a person: a
 * question it refuses to guess at, a wall only a human can clear, and the
 * go-ahead to submit. All of them are resolved from the API while the browser
 * stays open on the half-filled form, which is what makes the
 * popup-and-remember flow work at all.
 */
export async function runApplication(applicationId: string): Promise<void> {
  const app = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: { job: true, profile: { include: { facts: true, resumes: true } } },
  });

  const adapter = adapterFor(app.job.url);
  let page: Page | null = null;

  try {
    await setStatus(applicationId, 'PREPARING', `Using the ${adapter.id} adapter.`);
    for (const note of adapter.notes) {
      await bus.emitEvent(applicationId, 'LOG', `${adapter.id}: ${note}`);
    }

    page = await newPage();

    // ---- 1. Reach the form --------------------------------------------------
    if (!(await openForm(applicationId, page, adapter, app.job.url))) {
      await prisma.application.update({
        where: { id: applicationId },
        data: { status: 'CANCELLED', blockedReason: 'Could not reach application form.' },
      });
      return;
    }
    await artifact(applicationId, 'screenshot', 'form-opened', await screenshot(page, applicationId, 'form-opened'));

    // ---- 2. Read the posting ------------------------------------------------
    const meta = await adapter.readJobMeta(page);
    await prisma.job.update({
      where: { id: app.jobId },
      data: {
        company: meta.company || app.job.company,
        title: meta.title || app.job.title,
        location: meta.location ?? app.job.location,
        descriptionText: meta.descriptionText || app.job.descriptionText,
        ats: adapter.id,
      },
    });
    await bus.emitEvent(applicationId, 'LOG', `Read the posting: ${meta.title} at ${meta.company}.`);

    // ---- 3. Walk it ---------------------------------------------------------
    const walk = await walkApplication({ applicationId, page, adapter, app, meta });
    if (walk.kind === 'ABANDONED') {
      await prisma.application.update({
        where: { id: applicationId },
        data: { status: 'CANCELLED', blockedReason: 'Cancelled by user during human gate.' },
      });
      return;
    }

    // ---- 4. Review, then submit ---------------------------------------------
    await finishApplication({
      applicationId,
      page,
      adapter,
      app,
      plan: walk.plan,
      answers: walk.answers,
      fields: walk.fields,
      submitControl: walk.submitControl,
      companyKey: walk.companyKey,
    });
  } catch (err) {
    const message = (err as Error).message;
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: 'FAILED', blockedReason: message, attempts: { increment: 1 } },
    });
    await bus.emitEvent(applicationId, 'ERROR', message, { stack: (err as Error).stack });
    if (page) {
      await artifact(applicationId, 'screenshot', 'failure', await screenshot(page, applicationId, 'failure')).catch(() => {});
    }
  } finally {
    abandon(questionsKey(applicationId));
    abandon(reviewKey(applicationId));
    abandon(blockerKey(applicationId));
    // The page is left open on purpose while a human may still be looking at
    // it; closing here would destroy the evidence and any captcha token.
    if (page && !config.headless) {
      await bus.emitEvent(applicationId, 'LOG', 'Leaving the browser tab open for you.');
    } else {
      await page?.close().catch(() => {});
    }
  }
}

/**
 * Get from a job URL to something fillable.
 *
 * Opening can itself hit a wall - a sign-in page, a challenge - and that is
 * recoverable rather than terminal: the human deals with it in the browser
 * that is already open and the run tries again from there. Three attempts,
 * because a wall that survives two clearances is not a wall.
 *
 * Returns false when the run is over, having already said why.
 */
async function openForm(
  applicationId: string,
  page: Page,
  adapter: ReturnType<typeof adapterFor>,
  url: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await adapter.openApplicationForm(page, url);
      return true;
    } catch (err) {
      // Screenshot first, so there is something to look at either way.
      await artifact(
        applicationId,
        'screenshot',
        `could-not-open-${attempt}`,
        await screenshot(page, applicationId, `could-not-open-${attempt}`),
      ).catch(() => {});

      if (err instanceof NeedsHumanError && attempt < 3) {
        const carryOn = await pauseForHuman(applicationId, page, {
          kind: err.kind,
          detail: err.message,
          humanCanClear: true,
        });
        if (!carryOn) return false;
        continue;
      }
      await handleOpenFailure(applicationId, page, err);
      return false;
    }
  }
  return false;
}

export function submitAnswers(
  applicationId: string,
  replies: Array<{ fieldId: string; value: string | string[]; remember: boolean }>,
): boolean {
  return release(questionsKey(applicationId), replies);
}

/**
 * "I have signed in / solved it — keep going."
 *
 * Releases a run parked at a wall. Returns false when nothing was waiting,
 * which the API turns into a 409 rather than pretending it worked.
 */
export function continueRun(applicationId: string, carryOn: boolean, note?: string): boolean {
  return release(blockerKey(applicationId), { carryOn, note });
}

export function decideReview(applicationId: string, approved: boolean, note?: string): boolean {
  return release(reviewKey(applicationId), { approved, note });
}
