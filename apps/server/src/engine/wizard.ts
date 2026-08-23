import path from 'node:path';
import type { Page } from 'playwright';
import { normalizeLabel, type AnswerGap, type FormField, type ResolvedAnswer } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { bus } from '../lib/events.js';
import { screenshot } from '../browser/session.js';
import {
  fillField,
  attachFile,
  verifyFilled,
  inspectControl,
  alreadyHolds,
  FillError,
} from '../browser/fill.js';
import { detectBlockers } from '../browser/blockers.js';
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
  type AdvanceControl,
} from '../browser/steps.js';
import type { AtsAdapter, JobMeta } from '../ats/types.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { generateCoverLetter } from '../llm/coverLetter.js';
import { resolveField, type ResolveContext } from './resolver.js';
import { askHuman, pauseForHuman } from './humanGate.js';
import { artifact, setStatus, truncate, writeCoverLetterFile } from './runLog.js';
import { entry, type FieldPlanEntry } from './fieldPlan.js';

/**
 * Walking an application from its first screen to its last.
 *
 * An application is a wizard, not a form. Read what is on screen, fill it,
 * find the control that moves forward, press it, check something actually
 * changed - and repeat until reaching a control that ends the application. A
 * single-page Greenhouse form is the one-step case of the same loop.
 *
 * This is the whole middle of a run, and deliberately the only part that knows
 * about steps. Reaching the form, and deciding whether to submit once the end
 * is in sight, are each their own concern.
 */

export type RunRecord = Prisma.ApplicationGetPayload<{
  include: { job: true; profile: { include: { facts: true; resumes: true } } };
}>;

export type WalkOutcome =
  /** The human was asked to clear something and declined. Status is already set. */
  | { kind: 'ABANDONED' }
  /** Reached the end of the application. Nothing has been submitted yet. */
  | {
      kind: 'REACHED_END';
      plan: FieldPlanEntry[];
      answers: Map<string, ResolvedAnswer>;
      fields: FormField[];
      /**
       * The actual final button, when the walk ended holding one. More
       * reliable than the adapter's generic selector: on a wizard, "the submit
       * button" and "the button that ends the application" are only the same
       * thing on the last screen.
       */
      submitControl: AdvanceControl | null;
      companyKey: string;
    };

export async function walkApplication(args: {
  applicationId: string;
  page: Page;
  adapter: AtsAdapter;
  app: RunRecord;
  meta: JobMeta;
}): Promise<WalkOutcome> {
  const { applicationId, page, adapter, app, meta } = args;

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
      if (!carryOn) return { kind: 'ABANDONED' };
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

    const unfilledRequired: string[] = [];
    for (const field of fillable) {
      const answer = answers.get(field.id);
      if (!answer || answer.value === null || answer.displayValue === '') {
        plan.push(entry(field, answer, false));
        continue;
      }
      const wanted = answer.value as string | string[];

      // Is the site holding this field for us?
      //
      // Boards that parse the resume up front fill the identity fields from it
      // and then disable them, so the parse cannot be contradicted. Driving one
      // costs the full fill timeout and then reports a failure on a field that
      // was already right - three of those in a row put a minute on the clock
      // and three errors on the review screen.
      const state = await inspectControl(page, field);
      if (state.locked) {
        const correct = alreadyHolds(state.current, wanted);
        plan.push({
          ...entry(field, answer, correct),
          verified: state.current,
          error: correct
            ? undefined
            : `The site locked this field and it holds ${
                state.current ? `"${truncate(state.current)}"` : 'nothing'
              }.`,
        });
        await bus.emitEvent(
          applicationId,
          correct ? 'LOG' : 'WARNING',
          correct
            ? `"${field.label}" is locked by the site and already holds the right value.`
            : `"${field.label}" is locked by the site and cannot be changed from here.`,
        );
        if (!correct && field.required) unfilledRequired.push(field.label);
        continue;
      }

      const attempt = async (target: FormField) => {
        await fillField(page, target, wanted);
        return verifyFilled(page, target, wanted);
      };

      let check: Awaited<ReturnType<typeof verifyFilled>> | null = null;
      let failure = '';
      try {
        check = await attempt(field);
      } catch (err) {
        failure = err instanceof FillError ? err.message : (err as Error).message;

        // Filling one control routinely re-renders its neighbours — a phone
        // country picker rebuilds the number input beside it — and the
        // handle we stamped during extraction then points at a node that no
        // longer exists. Look the field up again by label before believing
        // it cannot be filled.
        const fresh = await refindField(page, adapter, field);
        if (fresh) {
          try {
            check = await attempt(fresh);
            failure = '';
            await bus.emitEvent(
              applicationId,
              'LOG',
              `"${field.label}" had been re-rendered; found it again and filled it.`,
            );
          } catch (retryErr) {
            failure = retryErr instanceof FillError ? retryErr.message : (retryErr as Error).message;
          }
        }
      }

      if (check) {
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
        continue;
      }

      plan.push({ ...entry(field, answer, false), error: failure });
      await bus.emitEvent(applicationId, 'WARNING', `Could not fill "${field.label}": ${failure}`);
      if (field.required) unfilledRequired.push(field.label);
    }

    if (unfilledRequired.length) {
      // One awkward dropdown used to end the whole application. The browser
      // is open on a form that is otherwise complete, and setting one field
      // by hand takes seconds - so this is a pause, like every other thing
      // only a person can do, not a failure.
      const carryOn = await pauseForHuman(applicationId, page, {
        kind: 'UNKNOWN',
        detail:
          `Could not fill ${unfilledRequired.map((l) => `"${l}"`).join(', ')}, which ` +
          `${unfilledRequired.length === 1 ? 'is' : 'are'} required. Everything else on this step ` +
          'is filled in - set those in the open browser and it will carry on.',
        humanCanClear: true,
      });
      if (!carryOn) return { kind: 'ABANDONED' };
      step--;
      continue;
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
        if (!carryOn) return { kind: 'ABANDONED' };
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

  return {
    kind: 'REACHED_END',
    plan,
    answers,
    fields: allFields,
    submitControl,
    companyKey: ctx.companyKey,
  };
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

/**
 * Find a field again after the page has rebuilt it.
 *
 * Handles are stamped onto elements during extraction, so anything that
 * re-renders invalidates them - and filling a control is one of the most
 * common ways to make that happen. Re-extracting and matching on the label is
 * the cheap recovery, and it is worth doing before reporting that a required
 * field cannot be filled at all.
 */
async function refindField(
  page: Page,
  adapter: { extractForm: (page: Page) => Promise<FormField[]> },
  wanted: FormField,
): Promise<FormField | null> {
  try {
    const fields = await adapter.extractForm(page);
    const target = normalizeLabel(wanted.label);

    // The control's own name, which survives a re-render. Matching on the
    // label alone is not enough and quietly does the wrong thing: Greenhouse's
    // phone block labels both the country picker and the number input "Phone",
    // so a lookup by label refound the wrong one, left the number empty, and
    // the submission was rejected for a field that looked filled.
    if (wanted.name) {
      const byName = fields.find((f) => f.name === wanted.name);
      if (byName) return byName;
    }
    if (wanted.canonicalKey) {
      const byKey = fields.find((f) => f.canonicalKey === wanted.canonicalKey);
      if (byKey) return byKey;
    }

    // Last resort: the same label AND the same kind, and only when that is
    // unambiguous. Guessing between two identically-labelled controls is worse
    // than admitting we cannot find it.
    const byLabel = fields.filter(
      (f) => normalizeLabel(f.label) === target && f.kind === wanted.kind,
    );
    return byLabel.length === 1 ? byLabel[0]! : null;
  } catch {
    return null;
  }
}
