import { bus } from '../lib/events.js';
import { prisma } from '../lib/db.js';
import { generateCoverLetter } from '../llm/coverLetter.js';

/**
 * Write the cover letter, and treat failure as degraded rather than fatal.
 *
 * It is usually an optional field, and losing it should not lose the whole
 * application - so this says so and returns undefined.
 */
export async function writeCoverLetter(
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
