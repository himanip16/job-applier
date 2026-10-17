import { prisma, type Prisma } from '../lib/db.js';
import { bus } from '../lib/events.js';
import { tailorResume } from '../resume/tailor.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { renderResume } from '../resume/render.js';

/** How long an application waits on resume tailoring before starting without it. */
const TAILOR_TIMEOUT_MS = 90_000;

/**
 * Logged when a bulk run is queued to tailor once it starts. The queue is in
 * memory, so after a restart this line is the only record that it wanted one.
 */
export const TAILOR_LATER_NOTE = 'Queued. Your resume will be tailored for this job when its turn comes.';

/**
 * Tailor the resume for one application and attach it.
 *
 * Never throws: a slow or failing model must not hold the application hostage,
 * so it says why and the run goes ahead with the default resume.
 */
export async function tailorForApplication(applicationId: string): Promise<string | null> {
  try {
    const app = await prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      include: { job: true, profile: { include: { facts: true, resumes: true } } },
    });
    const { job, profile: full } = app;
    if (!job.descriptionText || job.descriptionText.length < 200) return null;

    const base = full.resumes.find((r) => r.isDefault) ?? full.resumes[0];
    const resumeText = base?.text ?? full.resumeText;
    if (!resumeText || resumeText.trim().length < 100) return null;

    // The run does not start until this is done, so say so - otherwise
    // the page just reads "waiting" for as long as the model takes.
    await bus.emitEvent(applicationId, 'LOG', 'Tailoring your resume for this job before starting…');
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      tailorResume({
        candidateContext: renderCandidateContext(full, resumeText),
        resumeText,
        jobTitle: job.title,
        companyName: job.company,
        jobDescription: job.descriptionText,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('took longer than 90 seconds')), TAILOR_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));

    const rendered = await renderResume(result.text, {
      profileName: full.fullName,
      slug: `${job.company}-${job.title}`,
    });

    const tailored = await prisma.tailoredResume.create({
      data: {
        profileId: full.id,
        jobId: job.id,
        baseResumeId: base?.id ?? 'inline',
        label: `${job.title} at ${job.company}`,
        text: result.text,
        txtPath: rendered.txtPath,
        docxPath: rendered.docxPath,
        insertions: result.insertions as unknown as Prisma.InputJsonValue,
        unsupported: result.unsupported as unknown as Prisma.InputJsonValue,
        covered: result.covered as unknown as Prisma.InputJsonValue,
        coverage: result.coverage,
      },
    });
    await prisma.application.update({ where: { id: applicationId }, data: { tailoredResumeId: tailored.id } });
    return tailored.id;
  } catch (err) {
    console.error('Auto-tailor resume failed:', err);
    await bus
      .emitEvent(
        applicationId,
        'LOG',
        `Resume tailoring skipped (${(err as Error).message}). Applying with your default resume.`,
      )
      .catch(() => {});
    return null;
  }
}

/** Whether a queued application was waiting to be tailored when the process died. */
export async function wantedTailoring(applicationId: string): Promise<boolean> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { tailoredResumeId: true },
  });
  if (!app || app.tailoredResumeId) return false;
  // The latest word on tailoring decides: a note followed by an attempt that
  // failed means it already had its go.
  const last = await prisma.applicationEvent.findFirst({
    where: {
      applicationId,
      OR: [
        { message: TAILOR_LATER_NOTE },
        { message: { startsWith: 'Tailoring your resume for this job' } },
        { message: { startsWith: 'Resume tailoring skipped' } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { message: true },
  });
  return last?.message === TAILOR_LATER_NOTE;
}
