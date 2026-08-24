import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Prisma } from '../lib/db.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { tailorResume } from '../resume/tailor.js';
import { renderResume } from '../resume/render.js';
import type { RequireProfile } from './discovery.js';
import { NOT_YOURS, ownedApplication, ownedTailoredResume } from '../auth/ownership.js';

export function registerResumeRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  /**
   * Tailor the resume for one job.
   *
   * Returns three lists that are all worth reading, not just the new text:
   * what was already covered, what was added and on what evidence, and what
   * the job wants that you cannot honestly claim. The last one is the useful
   * output even on the days you do not send the resume.
   */
  app.post('/api/resume/tailor', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const body = z
      .object({
        jobId: z.string().optional(),
        leadId: z.string().optional(),
        /** Or paste a description directly. */
        jobTitle: z.string().optional(),
        companyName: z.string().optional(),
        jobDescription: z.string().optional(),
        baseResumeId: z.string().optional(),
      })
      .parse(req.body);

    const full = await prisma.profile.findUniqueOrThrow({
      where: { id: profile.id },
      include: { facts: true, resumes: true },
    });

    const base =
      full.resumes.find((r) => r.id === body.baseResumeId) ??
      full.resumes.find((r) => r.isDefault) ??
      full.resumes[0];
    const resumeText = base?.text ?? full.resumeText;
    if (!resumeText || resumeText.trim().length < 100) {
      return reply.code(400).send({
        error:
          'No usable resume text. Upload a text-based PDF, DOCX or TXT resume first - a scanned image cannot be tailored.',
      });
    }

    let jobTitle = body.jobTitle ?? '';
    let companyName = body.companyName ?? '';
    let jobDescription = body.jobDescription ?? '';
    let jobId: string | null = body.jobId ?? null;

    if (body.jobId) {
      const job = await prisma.job.findUniqueOrThrow({ where: { id: body.jobId } });
      jobTitle = job.title;
      companyName = job.company;
      jobDescription = job.descriptionText ?? '';
    } else if (body.leadId) {
      const lead = await prisma.jobLead.findUniqueOrThrow({ where: { id: body.leadId } });
      jobTitle = lead.title;
      companyName = lead.companyName;
      jobDescription = lead.descriptionText ?? '';
    }

    if (!jobDescription || jobDescription.length < 200) {
      return reply.code(400).send({
        error: 'Need the job description to tailor against. Provide jobId, leadId, or paste the text.',
      });
    }

    const result = await tailorResume({
      candidateContext: renderCandidateContext(full, resumeText),
      resumeText,
      jobTitle,
      companyName,
      jobDescription,
    });

    const rendered = await renderResume(result.text, {
      profileName: full.fullName,
      slug: `${companyName}-${jobTitle}`,
    });

    const record = await prisma.tailoredResume.create({
      data: {
        profileId: full.id,
        jobId,
        baseResumeId: base?.id ?? 'inline',
        label: `${jobTitle} at ${companyName}`,
        text: result.text,
        txtPath: rendered.txtPath,
        docxPath: rendered.docxPath,
        insertions: result.insertions as unknown as Prisma.InputJsonValue,
        unsupported: result.unsupported as unknown as Prisma.InputJsonValue,
        covered: result.covered as unknown as Prisma.InputJsonValue,
        coverage: result.coverage,
      },
    });

    return {
      tailoredResume: record,
      atsIssues: result.atsIssues,
      /**
       * Non-empty means the rewrite slipped an unsupported keyword past the
       * prompt and the post-check caught it. Surfaced rather than swallowed:
       * this is exactly the failure mode the design exists to prevent.
       */
      violations: result.violations,
      warning: result.violations.length
        ? `The rewrite introduced ${result.violations.length} keyword(s) with no evidence behind them (${result.violations.join(', ')}). Review before using this version.`
        : undefined,
    };
  });

  app.get('/api/resume/tailored', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const rows = await prisma.tailoredResume.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { tailored: rows.map((r) => ({ ...r, text: `${r.text.slice(0, 400)}…` })) };
  });

  app.get<{ Params: { id: string } }>('/api/resume/tailored/:id', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const row = await ownedTailoredResume(profile.id, req.params.id);
    if (!row) return reply.code(404).send(NOT_YOURS);
    return { tailored: row };
  });

  /** Attach a tailored resume to an application, so the tracker records it. */
  app.post<{ Params: { id: string } }>('/api/tracker/:id/resume', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const { tailoredResumeId } = z.object({ tailoredResumeId: z.string() }).parse(req.body);
    // Both halves have to be yours: the application it is attached to, and the
    // tailored resume being attached.
    if (!(await ownedApplication(profile.id, req.params.id))) return reply.code(404).send(NOT_YOURS);
    if (!(await ownedTailoredResume(profile.id, tailoredResumeId))) {
      return reply.code(404).send(NOT_YOURS);
    }
    const application = await prisma.application.update({
      where: { id: req.params.id },
      data: { tailoredResumeId },
    });
    return { application };
  });
}
