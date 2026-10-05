import type { Page } from 'playwright';
import type { AnswerGap, FormField, ResolvedAnswer } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { bus } from '../lib/events.js';
import { screenshot, unlessClosed } from '../browser/session.js';
import { detectBlockers, type Blocker } from '../browser/blockers.js';
import { abandon, park, questionsKey, blockerKey } from './waiters.js';
import { NeedsHumanError, NoFormError, describeDiagnosis } from '../browser/openForm.js';
import { setStatus, artifact } from './runLog.js';

/**
 * Every point where the run needs a person.
 *
 * Three of them, and they share a shape: park on a promise, tell the human
 * what is wanted, and keep the browser page exactly as it is until they have
 * dealt with it. Re-driving forty dropdowns to get back to where you were is
 * slow and fragile, and any captcha token the page has earned is bound to that
 * page instance - so a run waits rather than restarts.
 *
 *  - a question it refuses to guess at            -> askHuman
 *  - a wall only a person can clear               -> pauseForHuman
 *  - the end of the road                          -> handOffToHuman
 */
/**
 * Autopilot hit something only you can deal with, and moved on.
 *
 * Not a failure: the application is left in NEEDS_INPUT or NEEDS_HUMAN with
 * the reason, and the run ends so the queue can start the next one. An
 * autopilot batch that parked on its first question would apply to one job.
 */
export class SetAsideError extends Error {
  constructor(
    message: string,
    /** Whether the tab is still worth looking at. A question is answered in the app, not there. */
    readonly keepPage: boolean,
  ) {
    super(message);
  }
}

/** Autopilot is an application that does not need your go-ahead to submit. */
export async function isAutopilot(applicationId: string): Promise<boolean> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { requiresReview: true },
  });
  return app ? !app.requiresReview : false;
}

/**
 * Post the open questions and park until they come back.
 *
 * The `remember` flag each reply carries is recorded on the question, not
 * acted on here: answers reach the bank only after a submission is confirmed,
 * in persistLearnedAnswers. A run that dies halfway should not leave the bank
 * full of values no employer ever accepted.
 */
export async function askHuman(
  applicationId: string,
  page: Page,
  fields: FormField[],
  gaps: AnswerGap[],
): Promise<Map<string, ResolvedAnswer>> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const autopilot = await isAutopilot(applicationId);

  // Same ordering rule as the review gate: park first, announce second. The
  // questions are written to the database before the status changes, so a
  // client that reacts instantly still finds them.
  const replyPromise = autopilot
    ? null
    : park<Array<{ fieldId: string; value: string | string[]; remember: boolean }>>(
        questionsKey(applicationId),
      );

  const asked = await prisma.pendingQuestion.createManyAndReturn({
    select: { id: true },
    data: gaps.map((g) => {
      const f = byId.get(g.fieldId)!;
      return {
        applicationId,
        fieldId: f.id,
        fieldSelector: f.selector,
        rawLabel: f.label,
        helpText: f.helpText ?? null,
        fieldKind: f.kind,
        options: (f.options ?? undefined) as Prisma.InputJsonValue | undefined,
        required: f.required,
        reason: g.reason,
        suggestion: (g.suggestion ?? undefined) as Prisma.InputJsonValue | undefined,
        suggestionRationale: g.suggestionRationale ?? null,
      };
    }),
  });

  await setStatus(
    applicationId,
    'NEEDS_INPUT',
    `${gaps.length} question${gaps.length === 1 ? '' : 's'} need your answer before this can be submitted.`,
    { count: gaps.length },
  );
  await bus.emitEvent(applicationId, 'QUESTION_ASKED', 'Waiting on you.', {
    questions: gaps.map((g) => ({
      fieldId: g.fieldId,
      label: byId.get(g.fieldId)?.label,
      reason: g.reason,
      suggestion: g.suggestion,
      rationale: g.suggestionRationale,
    })),
  });

  // Answering later restarts the run with these answers (resumeAfterAnswers
  // in routes/applications.ts), so there is nothing to keep the page for.
  if (!replyPromise) {
    throw new SetAsideError(
      'Autopilot: set aside until you answer. It restarts by itself once you do; moving on to the next job.',
      false,
    );
  }

  // A closed tab ends the wait. The answers already given are on the pending
  // questions, so a fresh run picks them up rather than asking again.
  //
  // The in-memory release only works when the answer arrives in this process.
  // A run started from the terminal is answered in the web app, and the other
  // way round, so the database is watched as well: once every question asked
  // here has an answer, whoever wrote it, the run carries on.
  const answeredElsewhere = new AbortController();
  let replies: Awaited<typeof replyPromise>;
  try {
    replies = await unlessClosed(
      page,
      Promise.race([
        replyPromise,
        watchForAnswers(asked.map((q) => q.id), answeredElsewhere.signal),
      ]),
      'while waiting for your answers',
    );
  } finally {
    answeredElsewhere.abort();
    abandon(questionsKey(applicationId));
  }

  const out = new Map<string, ResolvedAnswer>();
  for (const reply of replies) {
    const field = byId.get(reply.fieldId);
    if (!field) continue;
    const display = Array.isArray(reply.value) ? reply.value.join(', ') : reply.value;
    out.set(reply.fieldId, {
      fieldId: reply.fieldId,
      value: reply.value,
      displayValue: display,
      source: 'USER',
      confidence: 1,
      rationale: 'You answered this.',
      remember: reply.remember,
      canonicalKey: field.canonicalKey,
    });
  }
  await setStatus(applicationId, 'FILLING', 'Got your answers, carrying on.');
  return out;
}

/** How often a parked run looks for answers written by another process. */
export const ANSWER_POLL_MS = 1500;

/**
 * Resolve once every one of these questions has an answer in the database.
 * Never resolves if `signal` fires first - the caller has its answers already.
 */
async function watchForAnswers(
  questionIds: string[],
  signal: AbortSignal,
): Promise<Array<{ fieldId: string; value: string | string[]; remember: boolean }>> {
  for (;;) {
    await new Promise((r) => setTimeout(r, ANSWER_POLL_MS));
    if (signal.aborted) return new Promise(() => {});
    const rows = await prisma.pendingQuestion.findMany({ where: { id: { in: questionIds } } });
    if (rows.length && rows.every((q) => q.answeredAt)) {
      return rows.map((q) => ({
        fieldId: q.fieldId,
        value: q.answerValue as string | string[],
        remember: q.remember,
      }));
    }
  }
}
export async function pauseForHuman(
  applicationId: string,
  page: Page,
  blocker: Blocker,
): Promise<boolean> {
  // Park BEFORE announcing, for the same reason as the review gate: a client
  // watching the run can see NEEDS_HUMAN and reply within microseconds, and a
  // reply that arrives before the promise exists is dropped forever.
  if (await isAutopilot(applicationId)) {
    await handOffToHuman(applicationId, page, blocker);
    throw new SetAsideError(
      'Autopilot: this needs you in the browser, so it is set aside with the tab left open. ' +
        'Start it again once that is dealt with. Moving on to the next job.',
      true,
    );
  }

  const key = blockerKey(applicationId);
  const manual = park<{ carryOn: boolean; note?: string }>(key);
  await handOffToHuman(applicationId, page, blocker);
  await nudge(applicationId, page, blocker);

  // Whichever comes first: you press the button, or the wall simply goes away
  // because you dealt with it. The second is the common case and it should not
  // require coming back to this app to say so.
  let decision: { carryOn: boolean; note?: string };
  try {
    decision = await unlessClosed(
      page,
      Promise.race([manual, watchForClearance(applicationId, page, blocker)]),
      'while waiting for you in the browser',
    );
  } finally {
    abandon(key);
  }

  if (!decision.carryOn) {
    await setStatus(applicationId, 'CANCELLED', decision.note ?? 'You cancelled this application.');
    return false;
  }
  await prisma.application.update({
    where: { id: applicationId },
    data: { blockedReason: null },
  });
  await bus.emitEvent(applicationId, 'LOG', 'Carrying on from where it stopped.');
  return true;
}
/**
 * Get in front of the person.
 *
 * A run that parks silently is a run that sits there until someone happens to
 * look at it. The action needed is almost always *in the browser window that
 * is already open* - sign in, solve this - so the most useful nudge is to put
 * that window in front of them. The terminal bell covers the case where the
 * browser is on another desktop, and the UI raises its own notification from
 * the status.
 */
async function nudge(applicationId: string, page: Page, blocker: Blocker): Promise<void> {
  if (!config.headless) {
    // Best-effort: a window manager may refuse, and that is not worth failing
    // a run over.
    await page.bringToFront().catch(() => {});
  }
  // \x07 is the terminal bell. One character, and it is the difference between
  // noticing in five seconds and noticing in five minutes.
  process.stdout.write(`\x07[needs you] ${blocker.kind}: ${blocker.detail}\n`);
  await bus.emitEvent(
    applicationId,
    'NEEDS_YOU',
    blocker.humanCanClear
      ? 'Waiting for you in the browser window. It carries on by itself once the page is past this.'
      : 'Waiting for you.',
    { kind: blocker.kind },
  );
}
/**
 * Notice when the human has dealt with it, without being told.
 *
 * "Press continue when you are done" is one more thing to remember, and the
 * app can just watch: the wall is either still on the page or it is not. Two
 * consecutive clear reads before believing it, because a page mid-navigation
 * briefly shows neither the wall nor the form.
 *
 * Never resolves while the wall is still up - the manual button is the other
 * half of the race and covers walls that cannot be detected as cleared.
 */
function watchForClearance(
  applicationId: string,
  page: Page,
  blocker: Blocker,
): Promise<{ carryOn: boolean; note?: string }> {
  return new Promise((resolve) => {
    let clearReads = 0;
    let announced = false;

    // "Could not fill these fields" is not something detectBlockers can see,
    // so it always read as cleared and the run looped: fail every dropdown,
    // pause, "looks dealt with" four seconds later, fail them all again. Only
    // walls the page can show clear themselves; the rest wait for your click.
    if (blocker.autoClears === false) return;

    const tick = async () => {
      if (page.isClosed()) return;
      try {
        const stillThere = (await detectBlockers(page)).some((b) => b.kind === blocker.kind);
        clearReads = stillThere ? 0 : clearReads + 1;
        if (clearReads >= 2) {
          if (!announced) {
            announced = true;
            await bus
              .emitEvent(applicationId, 'LOG', 'That looks dealt with — carrying on by itself.')
              .catch(() => {});
            resolve({ carryOn: true });
          }
          return;
        }
      } catch {
        // Navigating, or the page went away. Try again on the next tick.
      }
      if (!announced) setTimeout(() => void tick(), 2000);
    };

    setTimeout(() => void tick(), 2000);
  });
}
export async function handOffToHuman(applicationId: string, page: Page, blocker: Blocker): Promise<void> {
  await artifact(applicationId, 'screenshot', 'blocked', await screenshot(page, applicationId, 'blocked'));
  await prisma.application.update({
    where: { id: applicationId },
    data: { status: 'NEEDS_HUMAN', blockedReason: `${blocker.kind}: ${blocker.detail}` },
  });
  await bus.emitEvent(applicationId, 'BLOCKED', blocker.detail, { kind: blocker.kind });
}
export async function handleOpenFailure(applicationId: string, page: Page, err: unknown): Promise<void> {
  if (err instanceof NeedsHumanError) {
    await handOffToHuman(applicationId, page, {
      kind: err.kind,
      detail: err.message,
      humanCanClear: true,
    });
    return;
  }
  if (err instanceof NoFormError) {
    await bus.emitEvent(applicationId, 'ERROR', describeDiagnosis(err.diagnosis));
    await handOffToHuman(applicationId, page, {
      kind: 'UNKNOWN',
      detail:
        `${err.message} ${describeDiagnosis(err.diagnosis)} ` +
        'The browser is still open on it - if you can see an application form there, the selectors need updating for this site.',
      humanCanClear: true,
    });
    return;
  }
  throw err;
}