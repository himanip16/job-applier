import path from 'node:path';
import type { Page } from 'playwright';
import { normalizeLabel, type AnswerGap, type FormField, type ResolvedAnswer } from '@ja/shared';
import { prisma, type Prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { bus } from '../lib/events.js';
import { PageClosedError, screenshot } from '../browser/session.js';
import { attachFile } from '../browser/fill.js';
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
import { resolveFields, type ResolveContext } from './resolver.js';
import { askHuman, pauseForHuman } from './humanGate.js';
import { artifact, setStatus, truncate, writeCoverLetterFile } from './runLog.js';
import type { FieldPlanEntry } from './fieldPlan.js';
import { fillApplicationFields } from './wizardFields.js';
import { readAnswerCache, reuseCachedAnswers, saveToAnswerCache } from './answerCache.js';
import { BrowserEdits } from './browserEdits.js';
import {
  expandRepeatableSections,
  hasRepeatableSections,
  historyFromFacts,
  labelRepeatableFields,
  readResumeHistory,
  type ResumeHistory,
} from './repeatableSections.js';

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
      edits: BrowserEdits;
    };

interface WalkArgs {
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

interface WalkContext extends WalkArgs {
  edits: BrowserEdits;
  resume: RunRecord['profile']['resumes'][number] | undefined;
  earlierReplies: Awaited<ReturnType<typeof answersFromEarlierRuns>>;
  earlierDerived: Awaited<ReturnType<typeof readAnswerCache>>;
  ctx: ResolveContext;
  /** Jobs and schools to lay out in "Add another" sections; read on first need. */
  history?: ResumeHistory | null;
}

interface WalkState {
  plan: FieldPlanEntry[];
  allFields: FormField[];
  answers: Map<string, ResolvedAnswer>;
  resumeAttached: boolean;
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
}

type StepOutcome = 'CONTINUE' | 'ABANDONED' | 'REACHED_END';

export async function walkApplication(args: WalkArgs): Promise<WalkOutcome> {
  const context = await createWalkContext(args);
  const state: WalkState = {
    plan: [], allFields: [], answers: new Map(),
    resumeAttached: false, coverAttached: false, submitControl: null,
    step: 0, stuckSignature: null, afterHumanPause: false,
    navigationRetries: 0, handledPrompts: new Set(), rowsDeferredOn: null,
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
    return 'CONTINUE';
  }
  if (await handleAutofillPrompt(context, state, signature)) return 'CONTINUE';

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
  await resolveStepAnswers(context, state, fillable);
  const unfilledRequired = await fillApplicationFields(fillable, {
    applicationId, page, adapter, answers: state.answers, plan: state.plan,
    afterHumanPause: state.afterHumanPause,
  });
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

/** True only when answering the prompt moved to another screen. */
async function handleAutofillPrompt(
  { applicationId, page, resume }: WalkContext,
  state: WalkState,
  signature: string,
): Promise<boolean> {
  if (state.handledPrompts.has(signature)) return false;
  const prompt = await detectAutofillPrompt(page);
  if (!prompt) return false;
  state.handledPrompts.add(signature);
  const target = await chooseAutofill(applicationId, prompt, Boolean(resume));
  if (!target) return false;
  await page.click(target).catch(() => {});
  if (await waitForStepChange(page, signature, 20_000)) {
    state.step--;
    return true;
  }
  await bus.emitEvent(
    applicationId,
    'LOG',
    'That choice did not change the page; carrying on with the form as it is.',
  );
  return false;
}

async function readStepFields(
  context: WalkContext,
  state: WalkState,
  signature: string,
): Promise<{ fields: FormField[]; rowsDeferred: boolean }> {
  const { applicationId, page, adapter, earlierReplies, earlierDerived, ctx } = context;
  const { sessionAnswers } = ctx;
  // Extraction re-stamps handles; the last read's no longer point at its controls.
  context.edits.forget();
  const progress = await readStepProgress(page);
  await setStatus(applicationId, 'FILLING', describeStep(state.step, progress), { progress });

  const gate = await looksLikeAGate(page);
  let fields: FormField[] = [];
  let rowsDeferred = false;
  if (!gate) {
    // Handles restart at f0 on every extraction, so they are namespaced by
    // step before anything stores them - otherwise step 2's "f0" would
    // overwrite step 1's answer and its pending question.
    const sections = await hasRepeatableSections(page);
    // Resume first, then everything else. Workday's My Experience puts the
    // resume upload beside Work Experience and Education, and its parser adds
    // rows of its own - so adding rows before the upload left duplicates.
    // Hold the rows back once per screen; the walk attaches and reads again.
    rowsDeferred =
      sections &&
      !state.resumeAttached &&
      state.rowsDeferredOn !== signature &&
      (await page.locator('input[type="file"]').count().catch(() => 0)) > 0;
    if (rowsDeferred) state.rowsDeferredOn = signature;
    const history = sections && !rowsDeferred ? await workHistory(context) : null;
    if (history) {
      for (const r of await expandRepeatableSections(page, history)) {
        if (r.after === r.before) continue;
        await bus.emitEvent(
          applicationId,
          'LOG',
          `Added ${r.kind} rows: ${r.before} -> ${r.after} (you have ${r.wanted} on record).`,
        );
      }
    }
    fields = (await adapter.extractForm(page)).map((f) => ({ ...f, id: `s${state.step}:${f.id}` }));
    // Every row repeats the same labels; name each after the entry it is for.
    if (sections) fields = await labelRepeatableFields(page, fields, history);
    rekeyRereadStep(fields, state, sessionAnswers);
    state.allFields.push(...fields);
    carryOverEarlierReplies(fields, earlierReplies, sessionAnswers);
    reuseCachedAnswers(fields, earlierDerived, sessionAnswers);
    await bus.emitEvent(
      applicationId,
      'FORM_EXTRACTED',
      `Step ${state.step}: ${fields.length} field(s), ${fields.filter((f) => f.required).length} required.`,
      { step: state.step, fields },
    );
  }

  if (gate && state.step === 1) {
    throw new Error(
      'No form fields found on the page. The posting may be closed, or the form behind a wall.',
    );
  }
  return { fields, rowsDeferred };
}

/** Saved employment.N / education.N facts first; the resume only when there are none. */
async function workHistory(context: WalkContext): Promise<ResumeHistory | null> {
  if (context.history === undefined) {
    context.history =
      historyFromFacts(context.app.profile.facts) ??
      (await readResumeHistory(context.ctx.candidateContext).catch(() => null));
  }
  return context.history;
}

/** Generate only when requested or required, before resolving text fields. */
async function prepareCoverLetter(
  { applicationId, app, meta, ctx }: WalkContext,
  fields: FormField[],
  coverInput: FormField | undefined,
): Promise<void> {
  const { candidateContext } = ctx;
  const coverField = fields.find((f) => /cover letter/i.test(f.label) && f.kind === 'TEXTAREA');
  const demanded = coverField?.required === true || coverInput?.required === true;
  const wantsCoverLetter = (app.writeCoverLetter || demanded) && (!!coverInput || !!coverField);
  if (wantsCoverLetter && !ctx.coverLetter) {
    if (demanded && !app.writeCoverLetter) {
      await bus.emitEvent(
        applicationId,
        'LOG',
        'This form requires a cover letter, so one is being written even though the ' +
          'application was set not to.',
      );
    }
    ctx.coverLetter = await writeCoverLetter(applicationId, {
      candidateContext,
      companyName: meta.company,
      jobTitle: meta.title,
      jobDescription: meta.descriptionText,
    });
  }
}

async function resolveStepAnswers(
  { applicationId, page, ctx }: WalkContext,
  state: WalkState,
  fillable: FormField[],
): Promise<void> {
  const { sessionAnswers } = ctx;
  const gaps: AnswerGap[] = [];
  const resolved = await resolveFields(fillable, ctx);
  // Keep what the model worked out before anything can go wrong, so a
  // restart reuses it instead of paying for it again.
  await saveToAnswerCache(
    applicationId,
    fillable,
    new Map([...resolved].flatMap(([id, r]) => (r.kind === 'answer' ? [[id, r.answer] as const] : []))),
  );
  for (const field of fillable) {
    const res = resolved.get(field.id)!;
    if (res.kind === 'answer') {
      state.answers.set(field.id, res.answer);
      await bus.emitEvent(
        applicationId,
        'FIELD_RESOLVED',
        `${field.label}: ${truncate(res.answer.displayValue)} [${res.answer.source}]`,
        { fieldId: field.id, source: res.answer.source, confidence: res.answer.confidence },
      );
    } else if (!field.required) {
      // Questions are asked before anything is filled, so one optional box we
      // cannot answer (ServiceNow's Facebook, X and "Message to the Hiring
      // Team") left the whole form blank while the run waited on you. Blank
      // is a legitimate answer to an optional question; a guess is not.
      state.answers.set(field.id, {
        fieldId: field.id,
        value: null,
        displayValue: '',
        source: 'SKIPPED',
        confidence: 1,
        rationale: 'Optional, and nothing in your profile answers it, so it is left blank.',
        remember: false,
        canonicalKey: field.canonicalKey,
      });
      await bus.emitEvent(applicationId, 'FIELD_RESOLVED', `${field.label}: left blank (optional) [SKIPPED]`, {
        fieldId: field.id,
        source: 'SKIPPED',
        confidence: 1,
      });
    } else {
      gaps.push(res.gap);
    }
  }

  if (gaps.length) {
    const supplied = await askHuman(applicationId, page, fillable, gaps);
    for (const [fieldId, answer] of supplied) {
      state.answers.set(fieldId, answer);
      sessionAnswers.set(fieldId, answer);
    }
    const stillMissing = fillable.filter((f) => f.required && !state.answers.has(f.id));
    if (stillMissing.length) {
      throw new Error(
        `Required field(s) left unanswered: ${stillMissing.map((f) => f.label).join(', ')}`,
      );
    }
  }
}

async function pauseForRequiredFields(
  { applicationId, page, edits }: WalkContext,
  state: WalkState,
  unfilledRequired: string[],
): Promise<StepOutcome> {
  // Path and heading only: the field list changes under your hands as you
  // answer (Microsoft drops the Legal Name boxes on "same name? Yes").
  const where = (sig: string) => sig.split('#').slice(0, 2).join('#');
  const here = where(await pageSignature(page));
  let movedOn = false;
  const carryOn = await edits.during(pauseForHuman(applicationId, page, {
    clearedWhen: async () => {
      const now = await pageSignature(page).catch(() => '');
      movedOn = Boolean(now) && where(now) !== here;
      return movedOn;
    },
    kind: 'UNKNOWN',
    detail:
      `Could not fill ${unfilledRequired.map((l) => `"${l}"`).join(', ')}, which ` +
      `${unfilledRequired.length === 1 ? 'is' : 'are'} required. Everything else on this step ` +
      'is filled in - set those in the open browser and it will carry on.',
    humanCanClear: true,
    autoClears: false,
  }));
  if (!carryOn) return 'ABANDONED';
  // You pressed Next yourself: this is a new step, read it as one.
  if (movedOn) return 'CONTINUE';
  state.afterHumanPause = true;
  state.step--;
  return 'CONTINUE';
}

async function attachStepFiles(
  { applicationId, page, resume, ctx }: WalkContext,
  state: WalkState,
  { resume: resumeInput, coverLetter: coverInput }: ReturnType<AtsAdapter['fileInputs']>,
): Promise<boolean> {
  const { coverLetter } = ctx;
  let attached = false;
  if (resumeInput && !state.resumeAttached) {
    if (!resume) throw new Error('This form wants a resume and none is uploaded to your profile.');
    await attachFile(page, resumeInput.selector, path.resolve(resume.path));
    state.resumeAttached = true;
    attached = true;
    await bus.emitEvent(applicationId, 'FILE_ATTACHED', `Attached ${resume.filename}.`);
    state.plan.push({
      fieldId: resumeInput.id, label: resumeInput.label, kind: 'FILE', required: resumeInput.required,
      value: resume.filename, source: 'PROFILE', confidence: 1, filled: true,
    });
  }
  if (coverInput && coverLetter && !state.coverAttached) {
    const file = await writeCoverLetterFile(applicationId, coverLetter);
    await attachFile(page, coverInput.selector, file);
    state.coverAttached = true;
    attached = true;
    await bus.emitEvent(applicationId, 'FILE_ATTACHED', 'Attached the generated cover letter.');
  }
  return attached;
}

async function advanceStep(
  context: WalkContext,
  state: WalkState,
  signature: string,
): Promise<StepOutcome> {
  const { applicationId, page, adapter, edits } = context;
  // An upload or save can hold the continue button disabled for a moment.
  await adapter.settle?.(page);
  const advance = await findAdvanceControl(page);
  if (!advance) {
    // Nothing to press. On a one-page form that is normal - the adapter
    // knows how to submit it. Mid-wizard it means the markup changed.
    await bus.emitEvent(
      applicationId,
      'LOG',
      state.step === 1
        ? 'Single-page form; handing over to the adapter to submit.'
        : `No next or submit control on step ${state.step}; letting the adapter try to submit.`,
    );
    return 'REACHED_END';
  }

  if (advance.kind === 'SUBMIT') {
    state.submitControl = advance;
    await bus.emitEvent(
      applicationId,
      'LOG',
      `Reached the end of the application ("${advance.label}") after ${state.step} step(s).`,
    );
    return 'REACHED_END';
  }

  await artifact(
    applicationId,
    'screenshot',
    `step-${state.step}`,
    await screenshot(page, applicationId, `step-${state.step}`),
  ).catch(() => {});

  // Last look before the step's values leave the screen.
  await edits.capture();
  await page.click(advance.selector).catch(async (err: unknown) => {
    throw new Error(`Could not press "${advance.label}": ${(err as Error).message}`);
  });
  const moved = await waitForStepChange(page, signature, 20_000);
  if (!moved) return handleRejectedStep(context, state, signature, advance);
  edits.forget();
  state.stuckSignature = null;
  state.navigationRetries = 0;
  return 'CONTINUE';
}

async function handleRejectedStep(
  { applicationId, page, edits }: WalkContext,
  state: WalkState,
  signature: string,
  advance: AdvanceControl,
): Promise<StepOutcome> {
  // Pressing continue changed nothing. Almost always the step is
  // rejecting something; occasionally the button was not the one that
  // moves forward. Either way the page's own complaint is the useful
  // thing to report, not "the page did not change".
  const errors = await readValidationErrors(page);
  const detail = errors.length
    ? `Step ${state.step} would not accept the form: ${errors.join(' · ')}`
    : `Pressing "${advance.label}" on step ${state.step} did not move the application on, and the ` +
      'page gave no reason.';

  if (state.stuckSignature === signature) {
    const carryOn = await edits.during(pauseForHuman(applicationId, page, {
      kind: 'UNKNOWN',
      detail: `${detail} The browser is open on it - fix it there and continue, or cancel.`,
      humanCanClear: true,
      autoClears: false,
    }));
    if (!carryOn) return 'ABANDONED';
    state.afterHumanPause = true;
    state.stuckSignature = null;
    return 'CONTINUE';
  }

  // First failure: re-read the step. A rejected submit often reveals
  // fields that were not rendered before, and filling those is exactly
  // what the next iteration does.
  state.stuckSignature = signature;
  await bus.emitEvent(applicationId, 'WARNING', `${detail} Re-reading the step.`);
  state.step--;
  return 'CONTINUE';
}

async function recoverNavigation(
  { applicationId, page }: WalkContext,
  state: WalkState,
  err: unknown,
): Promise<void> {
  // The page moved while we were working on it. That is a wizard doing
  // its job, not a failure - look at wherever it landed instead. Bounded,
  // because a page that navigates on a timer would otherwise spin here
  // forever without ever making progress.
  // A closed tab also reads as "Target closed"; it is not coming back.
  if (page.isClosed() && !(err instanceof PageClosedError)) {
    throw new PageClosedError('while the form was being filled');
  }
  if (!isNavigationRace(err) || state.navigationRetries >= 4) throw err;
  state.navigationRetries++;
  state.step--;
  await bus.emitEvent(
    applicationId,
    'LOG',
    `The page navigated while it was being read; looking at where it landed (${state.navigationRetries}/4).`,
  );
}

/**
 * Answers given to this application on an earlier run that did not finish.
 *
 * The run most likely to need restarting is the one where you have just typed
 * two dozen answers and the tab then closed; asking all of them again is the
 * worst possible response to that.
 */
async function answersFromEarlierRuns(
  applicationId: string,
): Promise<Map<string, { label: string; value: string | string[]; remember: boolean }>> {
  const answered = await prisma.pendingQuestion.findMany({
    where: { applicationId, answeredAt: { not: null } },
    orderBy: { answeredAt: 'asc' },
  });
  const out = new Map<string, { label: string; value: string | string[]; remember: boolean }>();
  for (const q of answered) {
    const v = q.answerValue;
    if (typeof v !== 'string' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) continue;
    out.set(q.fieldId, { label: normalizeLabel(q.rawLabel), value: v as string | string[], remember: q.remember });
  }
  return out;
}

/**
 * Move this step's answers onto the handles of a fresh read of the same step.
 *
 * A step is read again after a pause (state.step is wound back), and handles
 * are positional: when the page re-renders with one control more or fewer,
 * every handle after it shifts. Answers were looked up by handle alone, so on
 * Microsoft's contact page the dial code landed in "Alternate Phone Number",
 * the phone number in "Address" and the country in "Postal Code/Zip". Answers
 * now follow the question, and a handle's old answer never outlives it.
 */
function rekeyRereadStep(
  fields: FormField[],
  state: WalkState,
  sessionAnswers: Map<string, ResolvedAnswer>,
): void {
  const prefix = `s${state.step}:`;
  const question = (f: FormField) => `${f.kind}:${normalizeLabel(f.label)}`;
  // Only the latest read of each handle owns what is stored under it.
  const byQuestion = new Map<string, ResolvedAnswer>();
  const seen = new Set<string>();
  for (const f of [...state.allFields].reverse()) {
    if (!f.id.startsWith(prefix) || seen.has(f.id)) continue;
    seen.add(f.id);
    const answer = sessionAnswers.get(f.id);
    if (answer && !byQuestion.has(question(f))) byQuestion.set(question(f), answer);
  }
  if (!seen.size) return;
  for (const id of seen) {
    sessionAnswers.delete(id);
    state.answers.delete(id);
  }
  for (const f of fields) {
    const answer = byQuestion.get(question(f));
    if (answer) sessionAnswers.set(f.id, { ...answer, fieldId: f.id });
  }
}

/**
 * Reuse an earlier reply for a field on this screen - only when it is the same
 * handle AND the same question, since handles are positional and a form that
 * changed between runs would otherwise put an answer in the wrong box.
 */
function carryOverEarlierReplies(
  fields: FormField[],
  earlier: Map<string, { label: string; value: string | string[]; remember: boolean }>,
  sessionAnswers: Map<string, ResolvedAnswer>,
): void {
  for (const field of fields) {
    const prior = earlier.get(field.id);
    if (!prior || prior.label !== normalizeLabel(field.label) || sessionAnswers.has(field.id)) continue;
    sessionAnswers.set(field.id, {
      fieldId: field.id,
      value: prior.value,
      displayValue: Array.isArray(prior.value) ? prior.value.join(', ') : prior.value,
      source: 'USER',
      confidence: 1,
      rationale: 'You answered this on an earlier attempt.',
      remember: prior.remember,
      canonicalKey: field.canonicalKey,
    });
  }
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
