import path from 'node:path';
import type { Page } from 'playwright';
import {
  getCanonical,
  matchCanonical,
  normalizeLabel,
  type FormField,
  type ResolvedAnswer,
  type AnswerGap,
} from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { config, artifactsDir } from '../lib/config.js';
import { bus } from '../lib/events.js';
import { newPage, screenshot, saveDom } from '../browser/session.js';
import { fillField, attachFile, verifyFilled, FillError } from '../browser/fill.js';
import { detectBlockers, detectSubmissionOutcome, type Blocker } from '../browser/blockers.js';
import { adapterFor } from '../ats/registry.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { generateCoverLetter } from '../llm/coverLetter.js';
import { resolveField, type ResolveContext } from './resolver.js';
import { rememberAnswer } from './answerBank.js';
import { park, release, questionsKey, reviewKey, abandon } from './waiters.js';

export class SubmissionBudgetError extends Error {}

interface FieldPlanEntry {
  fieldId: string;
  label: string;
  kind: FormField['kind'];
  required: boolean;
  value: string | string[] | null;
  source: string;
  confidence: number;
  rationale?: string;
  filled: boolean;
  verified?: string;
  error?: string;
}

/**
 * Drive one application end to end.
 *
 * The run parks (rather than exits) at two points: when a question cannot be
 * answered honestly, and when it is ready to submit. Both are resolved from
 * the API, which is what makes the popup-and-remember flow work while the
 * browser stays open on the half-filled form.
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
    await adapter.openApplicationForm(page, app.job.url);
    await artifact(applicationId, 'screenshot', 'form-opened', await screenshot(page, applicationId, 'form-opened'));

    // ---- Anything that stops us before we even start? --------------------
    const earlyBlockers = await detectBlockers(page);
    const hardBlocker = earlyBlockers.find(
      (b) => b.kind === 'LOGIN_REQUIRED' || b.kind === 'ACCOUNT_CREATION' || b.kind === 'EMAIL_VERIFICATION',
    );
    if (hardBlocker) {
      await handOffToHuman(applicationId, page, hardBlocker);
      return;
    }

    // ---- Job metadata ------------------------------------------------------
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

    // ---- Read the form -----------------------------------------------------
    await setStatus(applicationId, 'FILLING', 'Reading the form.');
    const fields = await adapter.extractForm(page);
    await bus.emitEvent(
      applicationId,
      'FORM_EXTRACTED',
      `Found ${fields.length} fields (${fields.filter((f) => f.required).length} required).`,
      { fields },
    );
    if (!fields.length) {
      throw new Error('No form fields found on the page. The posting may be closed or the form behind a wall.');
    }

    // ---- Resume + cover letter --------------------------------------------
    const resume =
      app.profile.resumes.find((r) => r.id === app.resumeFileId) ??
      app.profile.resumes.find((r) => r.isDefault) ??
      app.profile.resumes[0];
    const candidateContext = renderCandidateContext(
      app.profile,
      resume?.text ?? app.profile.resumeText,
    );

    const { resume: resumeInput, coverLetter: coverInput } = adapter.fileInputs(fields);
    const wantsCoverLetter =
      !!coverInput || fields.some((f) => /cover letter/i.test(f.label) && f.kind === 'TEXTAREA');

    let coverLetter = app.coverLetter ?? undefined;
    if (wantsCoverLetter && !coverLetter) {
      await bus.emitEvent(applicationId, 'LOG', 'Writing a cover letter for this role.');
      try {
        const generated = await generateCoverLetter({
          candidateContext,
          companyName: meta.company,
          jobTitle: meta.title,
          jobDescription: meta.descriptionText,
        });
        coverLetter = generated.body;
        await prisma.application.update({ where: { id: applicationId }, data: { coverLetter } });
        if (generated.unsupportedClaims.length) {
          await bus.emitEvent(
            applicationId,
            'WARNING',
            `The cover letter contains ${generated.unsupportedClaims.length} claim(s) not grounded in your resume. Check them before submitting.`,
            { unsupportedClaims: generated.unsupportedClaims },
          );
        }
        await bus.emitEvent(applicationId, 'COVER_LETTER', 'Cover letter ready.', { coverLetter });
      } catch (err) {
        // The cover letter is usually optional. Losing it is a degraded run,
        // not a failed one - say so and keep filling the rest of the form.
        await bus.emitEvent(
          applicationId,
          'WARNING',
          `Could not write a cover letter: ${(err as Error).message}. Carrying on without one.`,
        );
      }
    }

    // ---- Resolve every field ------------------------------------------------
    const sessionAnswers = new Map<string, ResolvedAnswer>();
    const ctx: ResolveContext = {
      profile: app.profile,
      candidateContext,
      companyName: meta.company,
      companyKey: normalizeLabel(meta.company),
      jobTitle: meta.title,
      jobDescription: meta.descriptionText,
      coverLetter,
      sessionAnswers,
    };

    const fillable = fields.filter((f) => f.kind !== 'FILE');
    let answers = new Map<string, ResolvedAnswer>();
    let gaps: AnswerGap[] = [];

    for (const field of fillable) {
      const res = await resolveField(field, ctx);
      if (res.kind === 'answer') {
        answers.set(field.id, res.answer);
        await bus.emitEvent(
          applicationId,
          'FIELD_RESOLVED',
          `${field.label}: ${truncate(res.answer.displayValue)} [${res.answer.source}]`,
          { fieldId: field.id, source: res.answer.source, confidence: res.answer.confidence },
        );
      } else {
        gaps.push(res.gap);
      }
    }

    // ---- Park on anything we refuse to guess -------------------------------
    if (gaps.length) {
      const supplied = await askHuman(applicationId, fillable, gaps);
      for (const [fieldId, answer] of supplied) {
        answers.set(fieldId, answer);
        sessionAnswers.set(fieldId, answer);
      }
      // Re-resolve any field the human left blank but that is still required.
      const stillMissing = fillable.filter((f) => f.required && !answers.has(f.id));
      if (stillMissing.length) {
        throw new Error(
          `Required field(s) left unanswered: ${stillMissing.map((f) => f.label).join(', ')}`,
        );
      }
    }

    // ---- Fill --------------------------------------------------------------
    const plan: FieldPlanEntry[] = [];
    for (const field of fillable) {
      const answer = answers.get(field.id);
      if (!answer || answer.value === null || answer.displayValue === '') {
        plan.push(entry(field, answer, false));
        continue;
      }
      try {
        await fillField(page, field, answer.value as string | string[]);
        const check = await verifyFilled(page, field, answer.value as string | string[]);
        plan.push({ ...entry(field, answer, true), verified: check.actual, error: check.ok ? undefined : 'value did not stick' });
        if (!check.ok) {
          await bus.emitEvent(
            applicationId,
            'WARNING',
            `"${field.label}" did not hold the value we set (page shows: ${truncate(check.actual)}).`,
          );
        }
      } catch (err) {
        const msg = err instanceof FillError ? err.message : (err as Error).message;
        plan.push({ ...entry(field, answer, false), error: msg });
        await bus.emitEvent(applicationId, 'WARNING', `Could not fill "${field.label}": ${msg}`);
        if (field.required) {
          throw new Error(`Required field "${field.label}" could not be filled: ${msg}`);
        }
      }
    }

    // ---- Attachments --------------------------------------------------------
    if (resumeInput && resume) {
      await attachFile(page, resumeInput.selector, path.resolve(resume.path));
      await bus.emitEvent(applicationId, 'FILE_ATTACHED', `Attached ${resume.filename}.`);
      plan.push({
        fieldId: resumeInput.id, label: resumeInput.label, kind: 'FILE', required: resumeInput.required,
        value: resume.filename, source: 'PROFILE', confidence: 1, filled: true,
      });
    } else if (resumeInput && !resume) {
      throw new Error('This form wants a resume and none is uploaded to your profile.');
    }

    if (coverInput && coverLetter) {
      const file = await writeCoverLetterFile(applicationId, coverLetter);
      await attachFile(page, coverInput.selector, file);
      await bus.emitEvent(applicationId, 'FILE_ATTACHED', 'Attached the generated cover letter.');
    }

    await prisma.application.update({
      where: { id: applicationId },
      data: { fieldPlan: plan as unknown as Prisma.InputJsonValue },
    });
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
    await enforceSubmitBudget();
    await setStatus(applicationId, 'SUBMITTING', 'Submitting.');
    const urlBefore = page.url();
    await adapter.submit(page);
    const outcome = await detectSubmissionOutcome(page, urlBefore);
    await artifact(applicationId, 'screenshot', 'after-submit', await screenshot(page, applicationId, 'after-submit'));

    if (outcome.outcome === 'SUBMITTED') {
      await prisma.application.update({
        where: { id: applicationId },
        data: { status: 'SUBMITTED', submittedAt: new Date(), confirmation: outcome.detail, blockedReason: null },
      });
      await bus.emitEvent(applicationId, 'STATUS', 'Submitted.', { status: 'SUBMITTED' });
      await persistLearnedAnswers(applicationId, app.profileId, fillable, answers, ctx.companyKey);
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
      await adapter.submit(page);
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
        await persistLearnedAnswers(applicationId, app.profileId, fillable, answers, ctx.companyKey);
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
 * Post the open questions and park until they come back.
 * Answers marked `remember` go into the bank immediately, so the very next
 * application benefits even if this one is later cancelled.
 */
async function askHuman(
  applicationId: string,
  fields: FormField[],
  gaps: AnswerGap[],
): Promise<Map<string, ResolvedAnswer>> {
  const byId = new Map(fields.map((f) => [f.id, f]));

  // Same ordering rule as the review gate: park first, announce second. The
  // questions are written to the database before the status changes, so a
  // client that reacts instantly still finds them.
  const replyPromise = park<Array<{ fieldId: string; value: string | string[]; remember: boolean }>>(
    questionsKey(applicationId),
  );

  await prisma.pendingQuestion.createMany({
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

  const replies = await replyPromise;

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

async function handOffToHuman(applicationId: string, page: Page, blocker: Blocker): Promise<void> {
  await artifact(applicationId, 'screenshot', 'blocked', await screenshot(page, applicationId, 'blocked'));
  await prisma.application.update({
    where: { id: applicationId },
    data: { status: 'NEEDS_HUMAN', blockedReason: `${blocker.kind}: ${blocker.detail}` },
  });
  await bus.emitEvent(applicationId, 'BLOCKED', blocker.detail, { kind: blocker.kind });
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

async function setStatus(
  applicationId: string,
  status: Prisma.ApplicationUpdateInput['status'],
  message: string,
  data?: unknown,
): Promise<void> {
  await prisma.application.update({
    where: { id: applicationId },
    data: { status, blockedReason: message },
  });
  await bus.emitEvent(applicationId, 'STATUS', message, { status, ...(data ?? {}) });
}

async function artifact(applicationId: string, kind: string, label: string, relPath: string): Promise<void> {
  await prisma.artifact.create({ data: { applicationId, kind, label, path: relPath } });
  bus.emit('artifact', { applicationId, kind, label, path: relPath });
}

async function writeCoverLetterFile(applicationId: string, text: string): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = path.join(artifactsDir, applicationId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'cover-letter.txt');
  await writeFile(file, text, 'utf8');
  return file;
}

function entry(field: FormField, answer: ResolvedAnswer | undefined, filled: boolean): FieldPlanEntry {
  return {
    fieldId: field.id,
    label: field.label,
    kind: field.kind,
    required: field.required,
    value: (answer?.value ?? null) as string | string[] | null,
    source: answer?.source ?? 'SKIPPED',
    confidence: answer?.confidence ?? 0,
    rationale: answer?.rationale,
    filled,
  };
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// --- external control surface, used by the API routes ----------------------

export function submitAnswers(
  applicationId: string,
  replies: Array<{ fieldId: string; value: string | string[]; remember: boolean }>,
): boolean {
  return release(questionsKey(applicationId), replies);
}

export function decideReview(applicationId: string, approved: boolean, note?: string): boolean {
  return release(reviewKey(applicationId), { approved, note });
}
