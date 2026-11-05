import path from 'node:path';
import type { AtsAdapter } from '../ats/types.js';
import { bus } from '../lib/events.js';
import { attachFile, fileBoxShowsFile } from '../browser/fill.js';
import type { FormField } from '@ja/shared';
import type { WalkContext, WalkState } from './wizard.js';
import { writeCoverLetterFile } from './runLog.js';
import { writeCoverLetter } from './coverLetterService.js';

export async function attachStepFiles(
  { applicationId, page, adapter, resume, ctx }: WalkContext,
  state: WalkState,
  { resume: resumeInput, coverLetter: coverInput }: ReturnType<AtsAdapter['fileInputs']>,
): Promise<boolean> {
  const { coverLetter } = ctx;
  let attached = false;
  // Once per step, and on a later step only if its box does not already show
  // the file - Workday carries it over on some tenants and not on others.
  const resumeWanted =
    resumeInput &&
    (!state.resumeAttached ||
      (state.resumeStep !== state.step &&
        !(await fileBoxShowsFile(page, resumeInput.selector, resume?.filename ?? ''))));
  if (resumeInput && resumeWanted) {
    if (!resume) throw new Error('This form wants a resume and none is uploaded to your profile.');
    // Some boards (Okta's) hide the real input behind their own uploader.
    if (adapter.attachFile) await adapter.attachFile(page, resumeInput, path.resolve(resume.path));
    else await attachFile(page, resumeInput.selector, path.resolve(resume.path));
    state.resumeAttached = true;
    state.resumeStep = state.step;
    attached = true;
    await bus.emitEvent(applicationId, 'FILE_ATTACHED', `Attached ${resume.filename}.`);
    state.plan.push({
      fieldId: resumeInput.id, label: resumeInput.label, kind: 'FILE', required: resumeInput.required,
      value: resume.filename, source: 'PROFILE', confidence: 1, filled: true,
    });
  }
  if (coverInput && coverLetter && !state.coverAttached) {
    const file = await writeCoverLetterFile(applicationId, coverLetter);
    if (adapter.attachFile) await adapter.attachFile(page, coverInput, file);
    else await attachFile(page, coverInput.selector, file);
    state.coverAttached = true;
    attached = true;
    await bus.emitEvent(applicationId, 'FILE_ATTACHED', 'Attached the generated cover letter.');
  }
  return attached;
}

/** Generate only when requested or required, before resolving text fields. */
export async function prepareCoverLetter(
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
