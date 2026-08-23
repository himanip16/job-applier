import type { Page } from 'playwright';
import { getCanonical, type FormField, type ResolvedAnswer } from '@ja/shared';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { bus } from '../lib/events.js';
import { screenshot, saveDom } from '../browser/session.js';
import { detectBlockers, detectSubmissionOutcome } from '../browser/blockers.js';
import type { AdvanceControl } from '../browser/steps.js';
import type { AtsAdapter } from '../ats/types.js';
import { rememberAnswer } from './answerBank.js';
import { park, reviewKey } from './waiters.js';
import { artifact, setStatus } from './runLog.js';
import type { FieldPlanEntry } from './fieldPlan.js';

/**
 * The last few feet, which are the ones that matter.
 *
 * Everything up to here is reversible. This is not, so two rules hold
 * throughout: nothing is submitted without the human's go-ahead when review is
 * on, and nothing is *recorded* as submitted without a confirmation actually
 * visible on the page. An application that may or may not have gone through is
 * reported as needing a human, never as done.
 */
export class SubmissionBudgetError extends Error {}

export async function finishApplication(args: {
  applicationId: string;
  page: Page;
  adapter: AtsAdapter;
  app: { requiresReview: boolean; profileId: string };
  plan: FieldPlanEntry[];
  answers: Map<string, ResolvedAnswer>;
  fields: FormField[];
  submitControl: AdvanceControl | null;
  companyKey: string;
}): Promise<void> {
  const { applicationId, page, adapter, app, plan, answers, fields, submitControl, companyKey } =
    args;

  const fillable = fields.filter((f) => f.kind !== 'FILE');
  await artifact(applicationId, 'screenshot', 'filled', await screenshot(page, applicationId, 'filled'));
  await artifact(applicationId, 'dom', 'filled-dom', await saveDom(page, applicationId, 'filled'));

  // ---- Blockers, second look ---------------------------------------------
  const blockers = await detectBlockers(page);
  const captcha = blockers.find((b) => b.kind === 'CAPTCHA');

  // ---- Review gate ---------------------------------------------------------
  const mustReview =
    app.requiresReview ||
    config.requireReview ||
    adapter.id === 'generic' ||
    !!captcha ||
    plan.some((p) => p.error) ||
    plan.some((p) => p.confidence < 0.9 && p.filled);

  if (mustReview) {
    const reason = captcha
      ? `${captcha.detail} The form is filled and waiting; solve the challenge in the browser, then approve here.`
      : adapter.id === 'generic'
        ? 'Unrecognised site, so this always goes through review.'
        : 'Filled and ready. Check it over, then approve.';
    // Register the waiter BEFORE announcing the status. Anything watching the
    // run - the UI, the CLI, a test - can observe REVIEW and answer within
    // microseconds, and if the parked promise does not exist yet that reply
    // is dropped and the run waits forever.
    const decisionPromise = park<{ approved: boolean; note?: string }>(reviewKey(applicationId));
    await setStatus(applicationId, 'REVIEW', reason, { blockers, plan });
    const decision = await decisionPromise;
    if (!decision.approved) {
      await setStatus(applicationId, 'CANCELLED', decision.note ?? 'You cancelled this application.');
      return;
    }
  }

  // ---- Submit ---------------------------------------------------------------
  //
  // The walk usually ends holding the actual final button, which is more
  // reliable than the adapter's generic selector - on a wizard, "the submit
  // button" and "the button that ends the application" are only the same
  // thing on the last screen.
  const pressSubmit = async () => {
    if (submitControl) {
      await page.click(submitControl.selector);
      return;
    }
    await adapter.submit(page);
  };

  await enforceSubmitBudget();
  await setStatus(
    applicationId,
    'SUBMITTING',
    submitControl ? `Submitting ("${submitControl.label}").` : 'Submitting.',
  );
  const urlBefore = page.url();
  await pressSubmit();
  const outcome = await detectSubmissionOutcome(page, urlBefore);
  await artifact(applicationId, 'screenshot', 'after-submit', await screenshot(page, applicationId, 'after-submit'));

  if (outcome.outcome === 'SUBMITTED') {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: 'SUBMITTED', submittedAt: new Date(), confirmation: outcome.detail, blockedReason: null },
    });
    await bus.emitEvent(applicationId, 'STATUS', 'Submitted.', { status: 'SUBMITTED' });
    await persistLearnedAnswers(applicationId, app.profileId, fillable, answers, companyKey);
    return;
  }

  if (outcome.outcome === 'VALIDATION_ERROR') {
    const retryPromise = park<{ approved: boolean; note?: string }>(reviewKey(applicationId));
    await setStatus(
      applicationId,
      'REVIEW',
      `The form rejected the submission: ${outcome.detail}. It is still open in the browser - fix it there and approve, or cancel.`,
    );
    const retry = await retryPromise;
    if (!retry.approved) {
      await setStatus(applicationId, 'CANCELLED', retry.note ?? 'Cancelled after a validation error.');
      return;
    }
    await pressSubmit();
    const second = await detectSubmissionOutcome(page, urlBefore);
    await prisma.application.update({
      where: { id: applicationId },
      data:
        second.outcome === 'SUBMITTED'
          ? { status: 'SUBMITTED', submittedAt: new Date(), confirmation: second.detail }
          : { status: 'FAILED', blockedReason: second.detail },
    });
    await bus.emitEvent(applicationId, 'STATUS', second.outcome, { status: second.outcome });
    if (second.outcome === 'SUBMITTED') {
      await persistLearnedAnswers(applicationId, app.profileId, fillable, answers, companyKey);
    }
    return;
  }

  // Ambiguous. Never claim success we cannot see.
  await prisma.application.update({
    where: { id: applicationId },
    data: { status: 'NEEDS_HUMAN', blockedReason: outcome.detail },
  });
  await bus.emitEvent(
    applicationId,
    'STATUS',
    'Submitted, but no confirmation was visible. Check the browser before assuming it went through.',
    { status: 'NEEDS_HUMAN', detail: outcome.detail },
  );
}

async function enforceSubmitBudget(): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await prisma.application.count({
    where: { status: 'SUBMITTED', submittedAt: { gte: since } },
  });
  if (recent >= config.maxSubmitsPerHour) {
    throw new SubmissionBudgetError(
      `Submission budget reached (${recent}/${config.maxSubmitsPerHour} in the last hour). ` +
        'This cap exists so a bug cannot spray fifty applications in your name.',
    );
  }
}

/**
 * Write the answers worth keeping into the bank, after a confirmed submit.
 * Doing it here rather than at resolve time means a run that dies halfway
 * never poisons the bank with values that were never actually accepted.
 */
async function persistLearnedAnswers(
  applicationId: string,
  profileId: string,
  fields: FormField[],
  answers: Map<string, ResolvedAnswer>,
  companyKey: string,
): Promise<void> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  let saved = 0;
  for (const [fieldId, answer] of answers) {
    if (!answer.remember && answer.source !== 'USER') continue;
    if (answer.source === 'GENERATED' || answer.source === 'SKIPPED') continue;
    const field = byId.get(fieldId);
    if (!field || answer.value === null) continue;
    const canonical = answer.canonicalKey ? getCanonical(answer.canonicalKey) : undefined;
    await rememberAnswer({
      profileId,
      canonicalKey: answer.canonicalKey,
      rawLabel: field.label,
      value: answer.value,
      displayValue: answer.displayValue,
      fieldKind: field.kind,
      options: field.options,
      source: answer.source === 'USER' ? 'USER' : 'INFERRED',
      confidence: answer.confidence,
      scope: canonical?.perCompany ? 'PER_COMPANY' : 'GLOBAL',
      companyKey,
    });
    saved++;
  }
  if (saved) {
    await bus.emitEvent(
      applicationId,
      'MEMORY_WRITTEN',
      `Saved ${saved} answer${saved === 1 ? '' : 's'} to your answer bank. Future applications will reuse them.`,
    );
  }
}
