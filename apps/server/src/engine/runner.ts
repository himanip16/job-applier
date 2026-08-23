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
import { NeedsHumanError, NoFormError, describeDiagnosis } from '../browser/openForm.js';
import {
  detectAutofillPrompt,
  findAdvanceControl,
  isNavigationRace,
  looksLikeAGate,
  pageSignature,
  readStepProgress,
  readValidationErrors,
  settle,
  waitForStepChange,
} from '../browser/steps.js';
import { adapterFor } from '../ats/registry.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { generateCoverLetter } from '../llm/coverLetter.js';
import { resolveField, type ResolveContext } from './resolver.js';
import { rememberAnswer } from './answerBank.js';
import { park, release, questionsKey, reviewKey, blockerKey, abandon } from './waiters.js';

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
 * An application is a wizard, not a form. The engine walks it one step at a
 * time - read what is on screen, fill it, find the control that moves forward,
 * press it, check something actually changed - until it reaches a control that
 * ends the application. A single-page Greenhouse form is just the one-step
 * case of the same loop.
 *
 * The run parks (rather than exits) at three points: when a question cannot be
 * answered honestly, when a human is needed to get past a login or a captcha,
 * and when it is ready to submit. All three are resolved from the API, which
 * is what makes the popup-and-remember flow work while the browser stays open
 * on the half-filled form.
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

    // Opening can itself hit a wall - a sign-in page, a challenge - and that
    // is recoverable rather than terminal: the human deals with it in the
    // browser that is already open and the run tries again from there. Three
    // attempts, because a wall that survives two clearances is not a wall.
    let opened = false;
    for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
      try {
        await adapter.openApplicationForm(page, app.job.url);
        opened = true;
      } catch (err) {
        // Reaching the form is its own failure mode, and both named cases mean
        // a person is needed rather than the run being broken. Screenshot first
        // so there is something to look at.
        await artifact(applicationId, 'screenshot', `could-not-open-${attempt}`, await screenshot(page, applicationId, `could-not-open-${attempt}`)).catch(() => {});

        if (err instanceof NeedsHumanError && attempt < 3) {
          const carryOn = await pauseForHuman(applicationId, page, {
            kind: err.kind,
            detail: err.message,
            humanCanClear: true,
          });
          if (!carryOn) return;
          continue;
        }
        await handleOpenFailure(applicationId, page, err);
        return;
      }
    }
    await artifact(applicationId, 'screenshot', 'form-opened', await screenshot(page, applicationId, 'form-opened'));

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

    // ---- Everything the walk will need -------------------------------------
    const resume =
      app.profile.resumes.find((r) => r.id === app.resumeFileId) ??
      app.profile.resumes.find((r) => r.isDefault) ??
      app.profile.resumes[0];
    const candidateContext = renderCandidateContext(
      app.profile,
      resume?.text ?? app.profile.resumeText,
    );

    const sessionAnswers = new Map<string, ResolvedAnswer>();
    const ctx: ResolveContext = {
      profile: app.profile,
      candidateContext,
      companyName: meta.company,
      companyKey: normalizeLabel(meta.company),
      jobTitle: meta.title,
      jobDescription: meta.descriptionText,
      coverLetter: app.coverLetter ?? undefined,
      sessionAnswers,
    };

    const plan: FieldPlanEntry[] = [];
    const allFields: FormField[] = [];
    const answers = new Map<string, ResolvedAnswer>();
    let coverLetter = app.coverLetter ?? undefined;
    let resumeAttached = false;
    let coverAttached = false;
    let submitControl: Awaited<ReturnType<typeof findAdvanceControl>> = null;

    // ---- Walk the wizard ----------------------------------------------------
    //
    // One iteration per screen. The order inside matters: a login wall or an
    // autofill prompt has to be dealt with before we go looking for fields,
    // because on those screens the fields we want do not exist yet.
    let step = 0;
    let stuckSignature: string | null = null;
    let navigationRetries = 0;
    // Answering a question about how to fill the form should happen once. A
    // detector that fires on something which is not really that question would
    // otherwise burn the whole step budget clicking it, which is precisely
    // what a stray "Enter manually" button did.
    const handledPrompts = new Set<string>();

    for (;;) {
      step++;
      if (step > config.maxApplicationSteps) {
        throw new Error(
          `Gave up after ${config.maxApplicationSteps} steps. Either this application is longer ` +
            'than expected (raise MAX_APPLICATION_STEPS) or the run is going in circles.',
        );
      }

      // Before reading anything. Arriving at a step is frequently a redirect
      // chain rather than a single navigation - Google Careers' Apply link
      // navigates, then bounces to accounts.google.com - and reading the page
      // between the two hops is how the run used to die with "Execution
      // context was destroyed".
      await settle(page);

      try {

      const signature = await pageSignature(page);

      // ---- A wall? -----------------------------------------------------------
      const wall = (await detectBlockers(page)).find(
        (b) =>
          b.kind === 'LOGIN_REQUIRED' ||
          b.kind === 'ACCOUNT_CREATION' ||
          b.kind === 'EMAIL_VERIFICATION' ||
          (b.kind === 'CAPTCHA' && /on screen/i.test(b.detail)),
      );
      if (wall) {
        // Resumable, not terminal. The browser profile persists, so once you
        // have signed in the run can pick up exactly where it stopped -
        // throwing the run away and making you start again would be a strange
        // way to treat a page that is now past the wall.
        const carryOn = await pauseForHuman(applicationId, page, wall);
        if (!carryOn) return;
        continue;
      }

      // ---- "Autofill with your resume?" --------------------------------------
      const prompt = handledPrompts.has(signature) ? null : await detectAutofillPrompt(page);
      if (prompt) {
        handledPrompts.add(signature);
        const target = await chooseAutofill(applicationId, prompt, Boolean(resume));
        if (target) {
          await page.click(target).catch(() => {});
          // If answering it did not change the page, it was not really a
          // question - carry straight on and treat what is here as the form,
          // rather than looping back and finding the same control again.
          if (await waitForStepChange(page, signature, 20_000)) {
            step--;
            continue;
          }
          await bus.emitEvent(
            applicationId,
            'LOG',
            'That choice did not change the page; carrying on with the form as it is.',
          );
        }
      }

      const progress = await readStepProgress(page);
      await setStatus(applicationId, 'FILLING', describeStep(step, progress), { progress });

      // ---- What is on this screen? -------------------------------------------
      const gate = await looksLikeAGate(page);
      let fields: FormField[] = [];
      if (!gate) {
        // Handles restart at f0 on every extraction, so they are namespaced by
        // step before anything stores them - otherwise step 2's "f0" would
        // overwrite step 1's answer and its pending question.
        fields = (await adapter.extractForm(page)).map((f) => ({ ...f, id: `s${step}:${f.id}` }));
        allFields.push(...fields);
        await bus.emitEvent(
          applicationId,
          'FORM_EXTRACTED',
          `Step ${step}: ${fields.length} field(s), ${fields.filter((f) => f.required).length} required.`,
          { step, fields },
        );
      }

      if (gate && step === 1) {
        throw new Error(
          'No form fields found on the page. The posting may be closed, or the form behind a wall.',
        );
      }

      const { resume: resumeInput, coverLetter: coverInput } = adapter.fileInputs(fields);

      // ---- A cover letter, the first time a step asks for one ----------------
      const wantsCoverLetter =
        !!coverInput || fields.some((f) => /cover letter/i.test(f.label) && f.kind === 'TEXTAREA');
      if (wantsCoverLetter && !coverLetter) {
        coverLetter = await writeCoverLetter(applicationId, {
          candidateContext,
          companyName: meta.company,
          jobTitle: meta.title,
          jobDescription: meta.descriptionText,
        });
        ctx.coverLetter = coverLetter;
      }

      // ---- Resolve, ask, fill -------------------------------------------------
      const fillable = fields.filter((f) => f.kind !== 'FILE');
      const gaps: AnswerGap[] = [];
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

      if (gaps.length) {
        const supplied = await askHuman(applicationId, fillable, gaps);
        for (const [fieldId, answer] of supplied) {
          answers.set(fieldId, answer);
          sessionAnswers.set(fieldId, answer);
        }
        const stillMissing = fillable.filter((f) => f.required && !answers.has(f.id));
        if (stillMissing.length) {
          throw new Error(
            `Required field(s) left unanswered: ${stillMissing.map((f) => f.label).join(', ')}`,
          );
        }
      }

      for (const field of fillable) {
        const answer = answers.get(field.id);
        if (!answer || answer.value === null || answer.displayValue === '') {
          plan.push(entry(field, answer, false));
          continue;
        }
        try {
          await fillField(page, field, answer.value as string | string[]);
          const check = await verifyFilled(page, field, answer.value as string | string[]);
          plan.push({
            ...entry(field, answer, true),
            verified: check.actual,
            error: check.ok ? undefined : 'value did not stick',
          });
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

      // ---- Attachments, on whichever step asks for them ----------------------
      if (resumeInput && !resumeAttached) {
        if (!resume) throw new Error('This form wants a resume and none is uploaded to your profile.');
        await attachFile(page, resumeInput.selector, path.resolve(resume.path));
        resumeAttached = true;
        await bus.emitEvent(applicationId, 'FILE_ATTACHED', `Attached ${resume.filename}.`);
        plan.push({
          fieldId: resumeInput.id, label: resumeInput.label, kind: 'FILE', required: resumeInput.required,
          value: resume.filename, source: 'PROFILE', confidence: 1, filled: true,
        });
      }
      if (coverInput && coverLetter && !coverAttached) {
        const file = await writeCoverLetterFile(applicationId, coverLetter);
        await attachFile(page, coverInput.selector, file);
        coverAttached = true;
        await bus.emitEvent(applicationId, 'FILE_ATTACHED', 'Attached the generated cover letter.');
      }

      await prisma.application.update({
        where: { id: applicationId },
        data: { fieldPlan: plan as unknown as Prisma.InputJsonValue },
      });

      // ---- Forward -------------------------------------------------------------
      const advance = await findAdvanceControl(page);
      if (!advance) {
        // Nothing to press. On a one-page form that is normal - the adapter
        // knows how to submit it. Mid-wizard it means the markup changed.
        await bus.emitEvent(
          applicationId,
          'LOG',
          step === 1
            ? 'Single-page form; handing over to the adapter to submit.'
            : `No next or submit control on step ${step}; letting the adapter try to submit.`,
        );
        break;
      }

      if (advance.kind === 'SUBMIT') {
        submitControl = advance;
        await bus.emitEvent(
          applicationId,
          'LOG',
          `Reached the end of the application ("${advance.label}") after ${step} step(s).`,
        );
        break;
      }

      await artifact(
        applicationId,
        'screenshot',
        `step-${step}`,
        await screenshot(page, applicationId, `step-${step}`),
      ).catch(() => {});

      await page.click(advance.selector).catch(async (err: unknown) => {
        throw new Error(`Could not press "${advance.label}": ${(err as Error).message}`);
      });
      const moved = await waitForStepChange(page, signature, 20_000);

      if (!moved) {
        // Pressing continue changed nothing. Almost always the step is
        // rejecting something; occasionally the button was not the one that
        // moves forward. Either way the page's own complaint is the useful
        // thing to report, not "the page did not change".
        const errors = await readValidationErrors(page);
        const detail = errors.length
          ? `Step ${step} would not accept the form: ${errors.join(' · ')}`
          : `Pressing "${advance.label}" on step ${step} did not move the application on, and the ` +
            'page gave no reason.';

        if (stuckSignature === signature) {
          const carryOn = await pauseForHuman(applicationId, page, {
            kind: 'UNKNOWN',
            detail: `${detail} The browser is open on it - fix it there and continue, or cancel.`,
            humanCanClear: true,
          });
          if (!carryOn) return;
          stuckSignature = null;
          continue;
        }

        // First failure: re-read the step. A rejected submit often reveals
        // fields that were not rendered before, and filling those is exactly
        // what the next iteration does.
        stuckSignature = signature;
        await bus.emitEvent(applicationId, 'WARNING', `${detail} Re-reading the step.`);
        step--;
        continue;
      }

      stuckSignature = null;
      navigationRetries = 0;
      } catch (err) {
        // The page moved while we were working on it. That is a wizard doing
        // its job, not a failure - look at wherever it landed instead. Bounded,
        // because a page that navigates on a timer would otherwise spin here
        // forever without ever making progress.
        if (!isNavigationRace(err) || navigationRetries >= 4) throw err;
        navigationRetries++;
        step--;
        await bus.emitEvent(
          applicationId,
          'LOG',
          `The page navigated while it was being read; looking at where it landed (${navigationRetries}/4).`,
        );
        continue;
      }
    }

    const fillable = allFields.filter((f) => f.kind !== 'FILE');
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
        await page!.click(submitControl.selector);
        return;
      }
      await adapter.submit(page!);
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
 * Post the open questions and park until they come back.
 * Answers marked `remember` go into the bank immediately, so the very next
 * application benefits even if this one is later cancelled.
 */
/**
 * Stop, let a person deal with it, and carry on.
 *
 * A login wall used to end the run. That is the wrong shape: the browser
 * profile persists, so once you have signed in the page in front of you is
 * past the wall and the application can continue from exactly where it
 * stopped. Throwing away a half-filled wizard and starting again is a strange
 * way to treat that.
 *
 * Returns false when the human cancelled instead.
 */
/**
 * The end of the road when the form cannot be reached.
 *
 * Kept apart from the retry loop above so that loop reads as what it is: try,
 * let a human clear the wall, try again. This is what happens when that has
 * been exhausted.
 */
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

async function handleOpenFailure(applicationId: string, page: Page, err: unknown): Promise<void> {
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

async function pauseForHuman(
  applicationId: string,
  page: Page,
  blocker: Blocker,
): Promise<boolean> {
  // Park BEFORE announcing, for the same reason as the review gate: a client
  // watching the run can see NEEDS_HUMAN and reply within microseconds, and a
  // reply that arrives before the promise exists is dropped forever.
  const key = blockerKey(applicationId);
  const manual = park<{ carryOn: boolean; note?: string }>(key);
  await handOffToHuman(applicationId, page, blocker);
  await nudge(applicationId, page, blocker);

  // Whichever comes first: you press the button, or the wall simply goes away
  // because you dealt with it. The second is the common case and it should not
  // require coming back to this app to say so.
  const decision = await Promise.race([manual, watchForClearance(applicationId, page, blocker)]);
  abandon(key);

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
 * Which side of the "autofill with your resume?" question to take.
 *
 * Autofill, when a resume is available. It is the employer's own parser
 * reading the candidate's own document, and it is the only practical way past
 * a page like Workday's My Experience, where the alternative is typing an
 * employment history the app does not hold in structured form.
 *
 * It does not weaken the no-fabrication rule, because of what happens next:
 * the loop re-reads the step, and anything the profile can answer is written
 * over the parsed value. Parsed values survive only where we had nothing, and
 * the whole application still goes through the review gate before submission.
 * The fixture deliberately parses a phone number wrong to keep that honest.
 */
async function chooseAutofill(
  applicationId: string,
  prompt: { question: string; autofillSelector: string | null; manualSelector: string | null },
  haveResume: boolean,
): Promise<string | null> {
  if (haveResume && prompt.autofillSelector) {
    await bus.emitEvent(
      applicationId,
      'LOG',
      `The site offered to autofill from the resume ("${prompt.question}") - taking it. ` +
        'Anything your profile can answer is written over the parsed value afterwards.',
    );
    return prompt.autofillSelector;
  }
  if (prompt.manualSelector) {
    await bus.emitEvent(
      applicationId,
      'LOG',
      haveResume
        ? `Filling this in manually ("${prompt.question}").`
        : `No resume on file, so filling manually ("${prompt.question}").`,
    );
    return prompt.manualSelector;
  }
  return null;
}

/** "Step 3 of 5: Application Questions", when the page says that much. */
function describeStep(
  step: number,
  progress: { index: number | null; total: number | null; label: string | null },
): string {
  const where =
    progress.index && progress.total
      ? `Step ${progress.index} of ${progress.total}`
      : `Step ${step}`;
  return progress.label ? `${where}: ${progress.label}` : where;
}

/**
 * Write the cover letter, and treat failure as degraded rather than fatal.
 *
 * It is usually an optional field, and losing it should not lose the whole
 * application - so this says so and returns undefined.
 */
async function writeCoverLetter(
  applicationId: string,
  args: {
    candidateContext: string;
    companyName: string;
    jobTitle: string;
    jobDescription: string;
  },
): Promise<string | undefined> {
  await bus.emitEvent(applicationId, 'LOG', 'Writing a cover letter for this role.');
  try {
    const generated = await generateCoverLetter(args);
    await prisma.application.update({
      where: { id: applicationId },
      data: { coverLetter: generated.body },
    });
    if (generated.unsupportedClaims.length) {
      await bus.emitEvent(
        applicationId,
        'WARNING',
        `The cover letter contains ${generated.unsupportedClaims.length} claim(s) not grounded in your resume. Check them before submitting.`,
        { unsupportedClaims: generated.unsupportedClaims },
      );
    }
    await bus.emitEvent(applicationId, 'COVER_LETTER', 'Cover letter ready.', {
      coverLetter: generated.body,
    });
    return generated.body;
  } catch (err) {
    await bus.emitEvent(
      applicationId,
      'WARNING',
      `Could not write a cover letter: ${(err as Error).message}. Carrying on without one.`,
    );
    return undefined;
  }
}

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
