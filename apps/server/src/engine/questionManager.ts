import type { Page } from 'playwright';
import type { AnswerGap, FormField, ResolvedAnswer } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { unlessClosed } from '../browser/session.js';
import { abandon, park, questionsKey } from './waiters.js';
import { setStatus } from './runLog.js';
import { whileWaitingOnHuman } from './slots.js';

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

/** How often a parked run looks for answers written by another process. */
export const ANSWER_POLL_MS = 1500;

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
    replies = await whileWaitingOnHuman(
      applicationId,
      unlessClosed(
        page,
        Promise.race([
          replyPromise,
          watchForAnswers(asked.map((q) => q.id), answeredElsewhere.signal),
        ]),
        'while waiting for your answers',
      ),
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
