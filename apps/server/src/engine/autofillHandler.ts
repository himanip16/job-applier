import type { Page } from 'playwright';
import { bus } from '../lib/events.js';
import { detectAutofillPrompt, waitForStepChange } from '../browser/steps.js';

interface AutofillPrompt {
  question: string;
  autofillSelector: string | null;
  manualSelector: string | null;
}

interface AutofillContext {
  applicationId: string;
  page: Page;
  resume: { filename: string } | undefined;
}

interface AutofillState {
  handledPrompts: Set<string>;
}

/**
 * True only when answering the prompt moved to another screen.
 */
export async function handleAutofillPrompt(
  { applicationId, page, resume }: AutofillContext,
  state: AutofillState,
  signature: string,
): Promise<{ shouldContinue: boolean; shouldDecrementStep: boolean }> {
  if (state.handledPrompts.has(signature)) return { shouldContinue: false, shouldDecrementStep: false };
  const prompt = await detectAutofillPrompt(page);
  if (!prompt) return { shouldContinue: false, shouldDecrementStep: false };
  state.handledPrompts.add(signature);
  const target = await chooseAutofill(applicationId, prompt, Boolean(resume));
  if (!target) return { shouldContinue: false, shouldDecrementStep: false };
  await page.click(target).catch(() => {});
  if (await waitForStepChange(page, signature, 20_000)) {
    return { shouldContinue: true, shouldDecrementStep: true };
  }
  await bus.emitEvent(
    applicationId,
    'LOG',
    'That choice did not change the page; carrying on with the form as it is.',
  );
  return { shouldContinue: true, shouldDecrementStep: false };
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
export async function chooseAutofill(
  applicationId: string,
  prompt: AutofillPrompt,
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
