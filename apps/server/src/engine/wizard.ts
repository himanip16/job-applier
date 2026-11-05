import type { Page } from 'playwright';
import { normalizeLabel, type AnswerGap, type FormField, type ResolvedAnswer } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { bus } from '../lib/events.js';
import { PageClosedError } from '../browser/session.js';
import { detectBlockers, inlineAccountPending } from '../browser/blockers.js';
import {
  looksLikeAGate,
  pageSignature,
  settle,
  type AdvanceControl,
} from '../browser/steps.js';
import type { AtsAdapter, JobMeta } from '../ats/types.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { resolveFields, type ResolveContext } from './resolver.js';
import { pauseForHuman } from './humanGate.js';
import { artifact, setStatus, truncate, writeCoverLetterFile } from './runLog.js';
import type { FieldPlanEntry } from './fieldPlan.js';
import { fillApplicationFields } from './wizardFields.js';
import { readAnswerCache } from './answerCache.js';
import { BrowserEdits } from './browserEdits.js';
import { handleAutofillPrompt } from './autofillHandler.js';
import { readStepFields, workHistory } from './stepReader.js';
import { resolveStepAnswers, askAboutGaps, followsANo } from './stepResolver.js';
import { attachStepFiles, prepareCoverLetter } from './fileAttacher.js';
import { advanceStep, recoverNavigation, awaitingParentPick, pauseForRequiredFields, type StepOutcome } from './stepNavigator.js';
import { answersFromEarlierRuns, carryOverEarlierReplies, rekeyRereadStep } from './answerReuse.js';

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
      submitControl: import('../browser/steps.js').AdvanceControl | null;
      companyKey: string;
      edits: BrowserEdits;
    };

export interface WalkArgs {
  applicationId: string;
  page: Page;
  adapter: AtsAdapter;
  app: RunRecord;
  meta: JobMeta;
  /** Where the form was opened from; walls can leave the browser elsewhere. */
  formUrl: string;
  /** Watches the tab for answers you change there. */
  edits?: BrowserEdits;
}

export interface WalkContext extends WalkArgs {
  edits: BrowserEdits;
  resume: RunRecord['profile']['resumes'][number] | undefined;
  earlierReplies: Awaited<ReturnType<typeof answersFromEarlierRuns>>;
  earlierDerived: Awaited<ReturnType<typeof readAnswerCache>>;
  ctx: ResolveContext;
  /** Jobs and schools to lay out in "Add another" sections; read on first need. */
  history?: import('./repeatableSections.js').ResumeHistory | null;
}

export interface WalkState {
  plan: FieldPlanEntry[];
  allFields: FormField[];
  answers: Map<string, ResolvedAnswer>;
  resumeAttached: boolean;
  // The step the resume last went on. Workday's "Autofill with Resume" takes
  // it on step 1, and some tenants (F5) ask again on My Experience with an
  // empty, required box of their own.
  resumeStep: number | null;
  coverAttached: boolean;
  submitControl: AdvanceControl | null;
  step: number;
  stuckSignature: string | null;
  // Only the next pass over the page preserves values entered in the browser.
  afterHumanPause: boolean;
  navigationRetries: number;
  handledPrompts: Set<string>;
  // The screen whose "Add another" rows were held back until its files went on.
  rowsDeferredOn: string | null;
  // The screen read again for dependent picklists' choices.
  cascadeRereadOn: string | null;
}

export async function walkApplication(args: WalkArgs): Promise<WalkOutcome> {
  const context = await createWalkContext(args);
  const state: WalkState = {
    plan: [], allFields: [], answers: new Map(),
    resumeAttached: false, resumeStep: null, coverAttached: false, submitControl: null,
    step: 0, stuckSignature: null, afterHumanPause: false,
    navigationRetries: 0, handledPrompts: new Set(), rowsDeferredOn: null,
    cascadeRereadOn: null,
  };

  context.edits.attach({ answers: state.answers, sessionAnswers: context.ctx.sessionAnswers, plan: state.plan });

  for (;;) {
    startStep(state);
    // Redirect chains must settle before reading, outside the recovery boundary.
    await settle(args.page);
    try {
      const outcome = await walkStep(context, state);
      if (outcome === 'ABANDONED') return { kind: 'ABANDONED' };
      if (outcome === 'REACHED_END') {
        return {
          kind: 'REACHED_END', plan: state.plan, answers: state.answers,
          fields: state.allFields, submitControl: state.submitControl,
          companyKey: context.ctx.companyKey, edits: context.edits,
        };
      }
    } catch (err) {
      await recoverNavigation(context, state, err);
    }
  }
}

async function createWalkContext(args: WalkArgs): Promise<WalkContext> {
  const { applicationId, app, meta } = args;
  const resume =
    app.profile.resumes.find((r) => r.id === app.resumeFileId) ??
    app.profile.resumes.find((r) => r.isDefault) ??
    app.profile.resumes[0];
  const candidateContext = renderCandidateContext(
    app.profile,
    resume?.text ?? app.profile.resumeText,
  );

  const sessionAnswers = new Map<string, ResolvedAnswer>();
  const earlierReplies = await answersFromEarlierRuns(applicationId);
  const earlierDerived = await readAnswerCache(applicationId);
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
  const edits =
    args.edits ??
    new BrowserEdits({ applicationId, page: args.page, profileId: app.profileId, companyKey: ctx.companyKey });
  return { ...args, edits, resume, earlierReplies, earlierDerived, ctx };
}

function startStep(state: WalkState): void {
  state.step++;
  if (state.step > config.maxApplicationSteps) {
    throw new Error(
      `Gave up after ${config.maxApplicationSteps} steps. Either this application is longer ` +
        'than expected (raise MAX_APPLICATION_STEPS) or the run is going in circles.',
    );
  }
}

/** One screen: clear walls and prompts before reading any form controls. */
async function walkStep(context: WalkContext, state: WalkState): Promise<StepOutcome> {
  const { applicationId, page, adapter } = context;
  await adapter.settle?.(page);
  const signature = await pageSignature(page);
  const wall = (await detectBlockers(page)).find(
    (b) =>
      b.kind === 'LOGIN_REQUIRED' ||
      b.kind === 'ACCOUNT_CREATION' ||
      b.kind === 'EMAIL_VERIFICATION' ||
      (b.kind === 'CAPTCHA' && /on screen/i.test(b.detail)),
  );
  if (wall) {
    if (!(await pauseForHuman(applicationId, page, wall))) return 'ABANDONED';
    await adapter.afterWall?.(page, context.formUrl);
    // A wall clears back onto the start page more often than not: Workday's
    // afterWall reopens `<posting>/apply`, the same "Autofill with Resume /
    // Apply Manually" screen answered before the sign-in. Still marked as
    // handled, it was read as an empty step with no button, taken for the end
    // of the form, and every Workday run went to review on the start page.
    state.handledPrompts.clear();
    return 'CONTINUE';
  }
  // The account is made by the application itself (SuccessFactors quick
  // apply): its boxes take the saved email and password - asking for the
  // password first if none is saved - and the rest of the form is read below.
  if (await inlineAccountPending(page)) {
    const account = {
      kind: 'ACCOUNT_CREATION' as const,
      detail: 'This application creates an account on the site as part of the form; it needs a password.',
      humanCanClear: true,
      // detectBlockers does not report these boxes as a wall, so it would call
      // this cleared at once; it is cleared when the password boxes are filled.
      clearedWhen: async () => !(await inlineAccountPending(page)),
    };
    if (!(await pauseForHuman(applicationId, page, account))) return 'ABANDONED';
  }
  const autofillResult = await handleAutofillPrompt({ applicationId, page, resume: context.resume }, state, signature);
  if (autofillResult.shouldContinue) {
    if (autofillResult.shouldDecrementStep) state.step--;
    return 'CONTINUE';
  }

  const { fields, rowsDeferred } = await readStepFields(context, state, signature);
  const fileInputs = adapter.fileInputs(fields);
  await prepareCoverLetter(context, fields, fileInputs.coverLetter);
  // Files first, then answers. Microsoft parses an uploaded resume into the
  // contact block - its State and City, and blanks Address and Postal Code -
  // so attaching after filling undid the fill, and every submission came
  // back "Address cannot be left blank". Attach, let the parse land, and read
  // the step again so the profile's answers go in over it.
  if (await attachStepFiles(context, state, fileInputs)) {
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await adapter.settle?.(page);
    state.step--;
    return 'CONTINUE';
  }
  // Nothing to attach after all; read the step again, this time adding rows.
  if (rowsDeferred) {
    state.step--;
    return 'CONTINUE';
  }
  const fillable = fields.filter((f) => f.kind !== 'FILE');
  const gaps = await resolveStepAnswers(context, state, fillable);
  const fillContext = {
    applicationId, page, adapter, answers: state.answers, plan: state.plan,
    afterHumanPause: state.afterHumanPause,
  };
  // Fill everything we can answer before asking about the rest. Asking first
  // left the whole form blank while the run waited on you: ServiceNow's
  // SmartRecruiters form has a required "To" date in every experience
  // editor, and the current job has none to give it.
  const unanswered = new Set(gaps.map((g) => g.fieldId));
  const unfilledRequired = await fillApplicationFields(
    fillable.filter((f) => !unanswered.has(f.id)),
    fillContext,
  );
  // SuccessFactors lists a dependent picklist's choices only once its parent
  // is picked: PayU's required "Details" under "How did you hear" had none
  // when the step was read, could not be answered, and stayed empty. Read the
  // step once more now the parents are set; boxes already filled are kept.
  if (state.cascadeRereadOn !== signature && (await awaitingParentPick(page, fillable))) {
    state.cascadeRereadOn = signature;
    await bus.emitEvent(applicationId, 'LOG', 'Some dropdowns depend on earlier answers; reading the page again for their choices.');
    state.step--;
    return 'CONTINUE';
  }
  if (gaps.length) {
    const asked = await askAboutGaps(context, state, fillable, gaps);
    unfilledRequired.push(...(await fillApplicationFields(asked, fillContext)));
  }
  // What the run put there; anything different later is you.
  await context.edits.baseline(fillable);
  // Only the page just worked on; later pages start fresh.
  state.afterHumanPause = false;
  if (unfilledRequired.length) return pauseForRequiredFields(context, state, unfilledRequired);

  await prisma.application.update({
    where: { id: applicationId },
    data: { fieldPlan: state.plan as unknown as Prisma.InputJsonValue },
  });
  if (adapter.beforeAdvance) {
    await adapter.beforeAdvance(page);
    // It changed the page itself; "did Next move us" is measured from here.
    return advanceStep(context, state, await pageSignature(page));
  }
  return advanceStep(context, state, signature);
}
