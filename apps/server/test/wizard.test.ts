import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { FormField, type ResolvedAnswer } from '@ja/shared';
import type { AtsAdapter } from '../src/ats/types.js';
import { walkApplication, type RunRecord } from '../src/engine/wizard.js';
import { prisma } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { bus } from '../src/lib/events.js';
import { detectBlockers } from '../src/browser/blockers.js';
import { attachFile, fillField, inspectControl, verifyFilled } from '../src/browser/fill.js';
import { PageClosedError } from '../src/browser/session.js';
import * as steps from '../src/browser/steps.js';
import { resolveFields } from '../src/engine/resolver.js';
import { askHuman, pauseForHuman } from '../src/engine/humanGate.js';
import { saveToAnswerCache } from '../src/engine/answerCache.js';
import { generateCoverLetter } from '../src/llm/coverLetter.js';

vi.mock('../src/lib/db.js', () => ({
  prisma: { pendingQuestion: { findMany: vi.fn() }, application: { update: vi.fn() } },
}));
vi.mock('../src/lib/config.js', () => ({ config: { maxApplicationSteps: 12 } }));
vi.mock('../src/lib/events.js', () => ({ bus: { emitEvent: vi.fn() } }));
vi.mock('../src/browser/blockers.js', () => ({ detectBlockers: vi.fn() }));
vi.mock('../src/browser/session.js', () => ({
  assertOpen: vi.fn(), screenshot: vi.fn(),
  PageClosedError: class PageClosedError extends Error {},
}));
vi.mock('../src/browser/fill.js', () => ({
  attachFile: vi.fn(), fillField: vi.fn(), inspectControl: vi.fn(), verifyFilled: vi.fn(),
  alreadyHolds: (actual: string, wanted: string) => actual === wanted,
  FillError: class FillError extends Error {},
}));
vi.mock('../src/browser/steps.js', () => ({
  detectAutofillPrompt: vi.fn(), findAdvanceControl: vi.fn(), looksLikeAGate: vi.fn(),
  pageSignature: vi.fn(), readStepProgress: vi.fn(), readValidationErrors: vi.fn(),
  settle: vi.fn(), waitForStepChange: vi.fn(),
  isNavigationRace: (err: Error) => err.message === 'navigation race',
}));
vi.mock('../src/llm/candidateContext.js', () => ({ renderCandidateContext: () => 'candidate' }));
vi.mock('../src/llm/coverLetter.js', () => ({ generateCoverLetter: vi.fn() }));
vi.mock('../src/engine/resolver.js', () => ({ resolveFields: vi.fn() }));
vi.mock('../src/engine/humanGate.js', () => ({ askHuman: vi.fn(), pauseForHuman: vi.fn() }));
vi.mock('../src/engine/answerCache.js', () => ({
  readAnswerCache: vi.fn().mockResolvedValue({}), reuseCachedAnswers: vi.fn(), saveToAnswerCache: vi.fn(),
}));
vi.mock('../src/engine/runLog.js', () => ({
  artifact: vi.fn().mockResolvedValue(undefined), setStatus: vi.fn(), truncate: (s: string) => s,
  writeCoverLetterFile: vi.fn().mockResolvedValue('/tmp/letter.txt'),
}));

const field = FormField.parse({ id: 'f0', label: 'Name', selector: '#name', kind: 'TEXT', required: true });
const next = { kind: 'NEXT' as const, label: 'Continue', selector: '#next' };
const submit = { kind: 'SUBMIT' as const, label: 'Submit', selector: '#submit' };
const answerFor = (id: string): ResolvedAnswer => ({
  fieldId: id, value: 'Himani', displayValue: 'Himani', source: 'PROFILE', confidence: 1, remember: false,
});
const page = { click: vi.fn(), isClosed: vi.fn() };
const adapter = {
  extractForm: vi.fn(), fileInputs: vi.fn(), submit: vi.fn(),
};
let app: RunRecord;
const walk = () => walkApplication({
  applicationId: 'application', page: page as unknown as Page, adapter: adapter as unknown as AtsAdapter,
  app, meta: { company: 'Example', title: 'Engineer', descriptionText: 'A job' },
  formUrl: 'https://example.com/apply',
});

beforeEach(() => {
  vi.clearAllMocks();
  app = { profile: { resumes: [], resumeText: 'Resume' }, coverLetter: null, writeCoverLetter: false } as unknown as RunRecord;
  Object.assign(config, { maxApplicationSteps: 12 });
  page.click.mockReset().mockResolvedValue(undefined);
  page.isClosed.mockReturnValue(false);
  adapter.extractForm.mockReset().mockResolvedValue([field]);
  adapter.fileInputs.mockReturnValue({});
  vi.mocked(prisma.pendingQuestion.findMany).mockResolvedValue([]);
  vi.mocked(prisma.application.update).mockResolvedValue({} as never);
  vi.mocked(detectBlockers).mockReset().mockResolvedValue([]);
  vi.mocked(steps.detectAutofillPrompt).mockReset().mockResolvedValue(null);
  vi.mocked(steps.findAdvanceControl).mockReset().mockResolvedValue(submit);
  vi.mocked(steps.looksLikeAGate).mockReset().mockResolvedValue(false);
  vi.mocked(steps.pageSignature).mockReset().mockResolvedValue('same-screen');
  vi.mocked(steps.readStepProgress).mockResolvedValue({ index: null, total: null, label: null });
  vi.mocked(steps.readValidationErrors).mockResolvedValue(['Invalid value']);
  vi.mocked(steps.waitForStepChange).mockReset().mockResolvedValue(true);
  vi.mocked(inspectControl).mockReset().mockResolvedValue({ locked: false, exists: true, current: '' });
  vi.mocked(fillField).mockReset().mockResolvedValue(undefined);
  vi.mocked(verifyFilled).mockReset().mockResolvedValue({ ok: true, actual: 'Himani' });
  vi.mocked(resolveFields).mockReset().mockImplementation(async (fields, ctx) => new Map(fields.map((f) => [
    f.id, { kind: 'answer', answer: ctx.sessionAnswers.get(f.id) ?? answerFor(f.id) },
  ])));
  vi.mocked(pauseForHuman).mockReset().mockResolvedValue(true);
  vi.mocked(askHuman).mockReset().mockResolvedValue(new Map());
  vi.mocked(generateCoverLetter).mockReset().mockResolvedValue({ body: 'Letter', claimsMade: [], unsupportedClaims: [] });
});

describe('walking an application', () => {
  it('namespaces each screen and stops before pressing the final submit control', async () => {
    vi.mocked(steps.findAdvanceControl).mockResolvedValueOnce(next);
    const result = await walk();
    expect(result).toMatchObject({ kind: 'REACHED_END', submitControl: submit, companyKey: 'example' });
    if (result.kind !== 'REACHED_END') throw new Error('Expected the final screen');
    expect(result.fields.map((f) => f.id)).toEqual(['s1:f0', 's2:f0']);
    expect([...result.answers.keys()]).toEqual(['s1:f0', 's2:f0']);
    expect(result.plan).toHaveLength(2);
    expect(page.click.mock.calls).toEqual([['#next']]);
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(prisma.application.update).toHaveBeenCalledTimes(2);
  });

  it('hands a form without navigation controls back to the adapter', async () => {
    vi.mocked(steps.findAdvanceControl).mockResolvedValue(null);
    expect(await walk()).toMatchObject({ kind: 'REACHED_END', submitControl: null });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('abandons a declined login wall before extracting or filling fields', async () => {
    vi.mocked(detectBlockers).mockResolvedValue([
      { kind: 'LOGIN_REQUIRED', detail: 'Sign in', humanCanClear: true, autoClears: false },
    ]);
    vi.mocked(pauseForHuman).mockResolvedValue(false);
    expect(await walk()).toEqual({ kind: 'ABANDONED' });
    expect(adapter.extractForm).not.toHaveBeenCalled();
  });

  it('does not charge a successful autofill choice against the step budget', async () => {
    Object.assign(config, { maxApplicationSteps: 1 });
    vi.mocked(steps.detectAutofillPrompt).mockResolvedValueOnce({
      question: 'Autofill?', manualSelector: '#manual', autofillSelector: '#autofill',
    });
    expect(await walk()).toMatchObject({ kind: 'REACHED_END', fields: [{ id: 's1:f0' }] });
    expect(page.click).toHaveBeenCalledWith('#manual');
  });

  it('handles a false autofill prompt once while re-reading a rejected step', async () => {
    vi.mocked(steps.detectAutofillPrompt).mockResolvedValue({
      question: 'Autofill?', manualSelector: '#manual', autofillSelector: '#autofill',
    });
    vi.mocked(steps.findAdvanceControl).mockResolvedValueOnce(next);
    vi.mocked(steps.waitForStepChange).mockResolvedValue(false);
    await walk();
    expect(steps.detectAutofillPrompt).toHaveBeenCalledTimes(1);
    expect(page.click.mock.calls).toEqual([['#manual'], ['#next']]);
  });

  it('asks after a second rejected advance and preserves browser edits on resumption', async () => {
    vi.mocked(steps.findAdvanceControl).mockResolvedValueOnce(next).mockResolvedValueOnce(next);
    vi.mocked(steps.waitForStepChange).mockResolvedValue(false);
    vi.mocked(verifyFilled)
      .mockResolvedValueOnce({ ok: true, actual: 'Himani' })
      .mockResolvedValueOnce({ ok: true, actual: 'Himani' })
      .mockResolvedValue({ ok: false, actual: 'Chosen in browser' });
    const result = await walk();
    expect(pauseForHuman).toHaveBeenCalledTimes(1);
    expect(fillField).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      kind: 'REACHED_END',
      plan: [expect.anything(), expect.anything(), {
        fieldId: 's2:f0', value: 'Chosen in browser', source: 'USER', filled: true,
      }],
    });
  });

  it('retries a required fill on the same step after the human fixes it', async () => {
    vi.mocked(fillField).mockRejectedValue(new Error('Cannot fill'));
    vi.mocked(verifyFilled).mockResolvedValue({ ok: false, actual: 'Manual answer' });
    const result = await walk();
    expect(pauseForHuman).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'REACHED_END', plan: [
      { fieldId: 's1:f0', filled: false, error: 'Cannot fill' },
      { fieldId: 's1:f0', filled: true, source: 'USER', value: 'Manual answer' },
    ] });
  });

  it('refinds a rerendered field by name before falling back to its label', async () => {
    adapter.extractForm.mockResolvedValueOnce([{ ...field, name: 'name' }]).mockResolvedValue([
      { ...field, name: 'other', selector: '#wrong' },
      { ...field, name: 'name', selector: '#replacement' },
    ]);
    vi.mocked(fillField).mockRejectedValueOnce(new Error('Detached'));
    await walk();
    expect(fillField).toHaveBeenLastCalledWith(page, expect.objectContaining({ selector: '#replacement' }), 'Himani');
    expect(pauseForHuman).not.toHaveBeenCalled();
  });

  it('accepts locked fields with the correct value without filling them', async () => {
    vi.mocked(inspectControl).mockResolvedValue({ locked: true, exists: true, current: 'Himani' });
    expect(await walk()).toMatchObject({ kind: 'REACHED_END', plan: [{ filled: true, verified: 'Himani' }] });
    expect(fillField).not.toHaveBeenCalled();
  });

  it('caches resolved answers before asking for missing required answers', async () => {
    vi.mocked(resolveFields).mockResolvedValue(new Map([
      ['s1:f0', { kind: 'gap', gap: { fieldId: 's1:f0', reason: 'NO_MATCH', suggestion: null } }],
    ]));
    await expect(walk()).rejects.toThrow('Required field(s) left unanswered: Name');
    expect(vi.mocked(saveToAnswerCache).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(askHuman).mock.invocationCallOrder[0]!);
    expect(fillField).not.toHaveBeenCalled();
  });

  it('generates a required cover letter and attaches files only once across retries', async () => {
    const resume = { id: 'resume', filename: 'resume.txt', path: '/tmp/resume.txt', isDefault: true };
    app.profile.resumes = [resume] as RunRecord['profile']['resumes'];
    const resumeInput = { ...field, id: 'resume', kind: 'FILE' as const, selector: '#resume' };
    const coverInput = { ...resumeInput, id: 'cover', selector: '#cover' };
    adapter.fileInputs.mockReturnValue({ resume: resumeInput, coverLetter: coverInput });
    vi.mocked(steps.findAdvanceControl).mockResolvedValueOnce(next);
    vi.mocked(steps.waitForStepChange).mockResolvedValue(false);
    await walk();
    expect(generateCoverLetter).toHaveBeenCalledTimes(1);
    expect(attachFile).toHaveBeenCalledTimes(2);
    expect(attachFile).toHaveBeenCalledWith(page, '#resume', '/tmp/resume.txt');
    expect(attachFile).toHaveBeenCalledWith(page, '#cover', '/tmp/letter.txt');
    expect(resolveFields).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ coverLetter: 'Letter' }));
  });

  it('bounds navigation races independently of the step budget', async () => {
    Object.assign(config, { maxApplicationSteps: 1 });
    vi.mocked(steps.pageSignature).mockRejectedValue(new Error('navigation race'));
    await expect(walk()).rejects.toThrow('navigation race');
    expect(steps.pageSignature).toHaveBeenCalledTimes(5);
    expect(bus.emitEvent).toHaveBeenCalledTimes(4);
  });

  it('resets the navigation retry allowance after advancing successfully', async () => {
    vi.mocked(steps.pageSignature)
      .mockRejectedValueOnce(new Error('navigation race'))
      .mockRejectedValueOnce(new Error('navigation race'))
      .mockRejectedValueOnce(new Error('navigation race'))
      .mockRejectedValueOnce(new Error('navigation race'))
      .mockResolvedValueOnce('first-screen')
      .mockRejectedValueOnce(new Error('navigation race'));
    vi.mocked(steps.findAdvanceControl).mockResolvedValueOnce(next);
    expect(await walk()).toMatchObject({ kind: 'REACHED_END' });
    expect(steps.pageSignature).toHaveBeenCalledTimes(7);
  });

  it('turns a closed page into a terminal error instead of retrying', async () => {
    page.isClosed.mockReturnValue(true);
    vi.mocked(steps.pageSignature).mockRejectedValue(new Error('navigation race'));
    await expect(walk()).rejects.toBeInstanceOf(PageClosedError);
    expect(steps.pageSignature).toHaveBeenCalledTimes(1);
  });

  it('enforces the maximum number of application steps', async () => {
    Object.assign(config, { maxApplicationSteps: 1 });
    vi.mocked(steps.findAdvanceControl).mockResolvedValue(next);
    await expect(walk()).rejects.toThrow('Gave up after 1 steps');
  });
});
