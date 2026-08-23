import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Prisma } from '../lib/db.js';
import { rememberAnswer } from '../engine/answerBank.js';
import { normalizeLabel } from '@ja/shared';
import type { RequireProfile } from './discovery.js';

/**
 * The tracker.
 *
 * `Application.status` is how far the automation got. `Application.outcome` is
 * where you stand with the employer. Those are different facts — a run can be
 * SUBMITTED while the outcome is REJECTED — and keeping them in one column
 * loses both.
 */
export function registerTrackerRoutes(app: FastifyInstance, requireProfile: RequireProfile) {
  app.get<{ Querystring: { outcome?: string } }>('/api/tracker', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const applications = await prisma.application.findMany({
      where: {
        profileId: profile.id,
        ...(req.query.outcome && req.query.outcome !== 'ALL'
          ? { outcome: req.query.outcome as Prisma.ApplicationWhereInput['outcome'] }
          : {}),
      },
      include: {
        job: true,
        rounds: { orderBy: { sequence: 'asc' }, include: { questions: true } },
        lessons: { orderBy: { createdAt: 'desc' } },
        _count: { select: { rounds: true, lessons: true } },
      },
      orderBy: [{ submittedAt: 'desc' }, { updatedAt: 'desc' }],
      take: 200,
    });

    // Resolve the artefacts that actually went out, so the row can show them.
    const resumeIds = applications.map((a) => a.resumeFileId).filter(Boolean) as string[];
    const tailoredIds = applications.map((a) => a.tailoredResumeId).filter(Boolean) as string[];
    const [resumes, tailored] = await Promise.all([
      prisma.resumeFile.findMany({
        where: { id: { in: resumeIds } },
        select: { id: true, label: true, filename: true },
      }),
      prisma.tailoredResume.findMany({
        where: { id: { in: tailoredIds } },
        select: { id: true, label: true, coverage: true, docxPath: true, txtPath: true },
      }),
    ]);
    const resumeById = new Map(resumes.map((r) => [r.id, r]));
    const tailoredById = new Map(tailored.map((t) => [t.id, t]));

    const stats = await prisma.application.groupBy({
      by: ['outcome'],
      where: { profileId: profile.id },
      _count: true,
    });

    return {
      applications: applications.map((a) => ({
        ...a,
        // The plan and the letter are big; the detail view fetches them.
        fieldPlan: undefined,
        coverLetter: a.coverLetter ? `${a.coverLetter.slice(0, 200)}…` : null,
        resumeUsed: a.resumeFileId ? resumeById.get(a.resumeFileId) : null,
        tailoredUsed: a.tailoredResumeId ? tailoredById.get(a.tailoredResumeId) : null,
      })),
      stats: Object.fromEntries(stats.map((s) => [s.outcome, s._count])),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/tracker/:id', async (req) => {
    const body = z
      .object({
        outcome: z
          .enum(['IN_PROGRESS', 'REJECTED', 'GHOSTED', 'WITHDRAWN', 'OFFER', 'ACCEPTED', 'DECLINED'])
          .optional(),
        outcomeNote: z.string().optional(),
        notes: z.string().optional(),
      })
      .parse(req.body);

    const application = await prisma.application.update({
      where: { id: req.params.id },
      data: {
        ...body,
        ...(body.outcome ? { outcomeAt: new Date() } : {}),
      },
    });
    return { application };
  });

  // ---------------------------------------------------------------- rounds ---

  app.post<{ Params: { id: string } }>('/api/tracker/:id/rounds', async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        scheduledAt: z.string().datetime().optional(),
        format: z.string().optional(),
        interviewers: z.string().optional(),
        notes: z.string().optional(),
      })
      .parse(req.body);

    const count = await prisma.interviewRound.count({ where: { applicationId: req.params.id } });
    const round = await prisma.interviewRound.create({
      data: {
        applicationId: req.params.id,
        name: body.name,
        sequence: count,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        format: body.format ?? null,
        interviewers: body.interviewers ?? null,
        notes: body.notes ?? null,
      },
    });
    // Getting to an interview means the application is live, whatever it said.
    await prisma.application.update({
      where: { id: req.params.id },
      data: { outcome: 'IN_PROGRESS' },
    });
    return { round };
  });

  app.patch<{ Params: { id: string } }>('/api/rounds/:id', async (req) => {
    const body = z
      .object({
        name: z.string().optional(),
        status: z.enum(['SCHEDULED', 'PASSED', 'FAILED', 'CANCELLED', 'PENDING_RESULT']).optional(),
        scheduledAt: z.string().datetime().nullable().optional(),
        completedAt: z.string().datetime().nullable().optional(),
        format: z.string().optional(),
        interviewers: z.string().optional(),
        notes: z.string().optional(),
      })
      .parse(req.body);

    const round = await prisma.interviewRound.update({
      where: { id: req.params.id },
      data: {
        ...body,
        scheduledAt: body.scheduledAt === undefined ? undefined : body.scheduledAt ? new Date(body.scheduledAt) : null,
        completedAt: body.completedAt === undefined ? undefined : body.completedAt ? new Date(body.completedAt) : null,
      },
    });
    return { round };
  });

  app.delete<{ Params: { id: string } }>('/api/rounds/:id', async (req) => {
    await prisma.interviewRound.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ------------------------------------------------------------- questions ---

  /**
   * A question you were actually asked.
   *
   * If you also wrote down your answer, it goes into the answer bank as well:
   * "why do you want to leave your current role" is asked on forms and in
   * screens alike, and an answer you have already thought about is worth more
   * than one generated fresh. Stored PER_COMPANY-agnostic but clearly labelled
   * as interview material.
   */
  app.post<{ Params: { id: string } }>('/api/rounds/:id/questions', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;
    const body = z
      .object({
        question: z.string().min(1),
        myAnswer: z.string().optional(),
        selfRating: z.enum(['GOOD', 'OK', 'POOR']).optional(),
        category: z.string().optional(),
        reuseAnswer: z.boolean().default(false),
      })
      .parse(req.body);

    const question = await prisma.interviewQuestion.create({
      data: {
        roundId: req.params.id,
        question: body.question,
        myAnswer: body.myAnswer ?? null,
        selfRating: body.selfRating ?? null,
        category: body.category ?? null,
      },
    });

    if (body.reuseAnswer && body.myAnswer) {
      await rememberAnswer({
        profileId: profile.id,
        rawLabel: body.question,
        value: body.myAnswer,
        displayValue: body.myAnswer,
        fieldKind: 'TEXTAREA',
        source: 'USER',
        confidence: 1,
        scope: 'GLOBAL',
      });
    }
    return { question };
  });

  app.patch<{ Params: { id: string } }>('/api/questions/:id', async (req) => {
    const body = z
      .object({
        question: z.string().optional(),
        myAnswer: z.string().optional(),
        selfRating: z.enum(['GOOD', 'OK', 'POOR']).optional(),
        category: z.string().optional(),
      })
      .parse(req.body);
    return { question: await prisma.interviewQuestion.update({ where: { id: req.params.id }, data: body }) };
  });

  app.delete<{ Params: { id: string } }>('/api/questions/:id', async (req) => {
    await prisma.interviewQuestion.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // --------------------------------------------------------------- lessons ---

  app.post<{ Params: { id: string } }>('/api/tracker/:id/lessons', async (req) => {
    const body = z
      .object({
        text: z.string().min(1),
        category: z.string().optional(),
        roundId: z.string().optional(),
      })
      .parse(req.body);
    const lesson = await prisma.lesson.create({
      data: {
        applicationId: req.params.id,
        roundId: body.roundId ?? null,
        text: body.text,
        category: body.category ?? null,
      },
    });
    return { lesson };
  });

  app.delete<{ Params: { id: string } }>('/api/lessons/:id', async (req) => {
    await prisma.lesson.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  /**
   * Everything you have written down about what went wrong, in one place, with
   * the questions you were asked alongside it. This is the view that is worth
   * the whole tracker after a couple of months of searching.
   */
  app.get('/api/retrospective', async (req, reply) => {
    const profile = await requireProfile(req, reply);
    if (!profile) return;

    const [lessons, questions, outcomes] = await Promise.all([
      prisma.lesson.findMany({
        where: { application: { profileId: profile.id } },
        include: { application: { include: { job: true } }, round: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.interviewQuestion.findMany({
        where: { round: { application: { profileId: profile.id } } },
        include: { round: { include: { application: { include: { job: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      prisma.application.groupBy({
        by: ['outcome'],
        where: { profileId: profile.id },
        _count: true,
      }),
    ]);

    // Group repeated questions: a question three companies asked is a question
    // to prepare properly.
    const grouped = new Map<string, { question: string; asked: number; companies: string[]; answers: string[] }>();
    for (const q of questions) {
      const key = normalizeLabel(q.question);
      const company = q.round.application.job.company;
      const entry = grouped.get(key) ?? { question: q.question, asked: 0, companies: [], answers: [] };
      entry.asked++;
      if (!entry.companies.includes(company)) entry.companies.push(company);
      if (q.myAnswer && !entry.answers.includes(q.myAnswer)) entry.answers.push(q.myAnswer);
      grouped.set(key, entry);
    }

    const byCategory = new Map<string, number>();
    for (const l of lessons) {
      const c = l.category ?? 'uncategorised';
      byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
    }

    return {
      lessons: lessons.map((l) => ({
        id: l.id,
        text: l.text,
        category: l.category,
        createdAt: l.createdAt,
        job: `${l.application.job.title} at ${l.application.job.company}`,
        round: l.round?.name ?? null,
      })),
      lessonsByCategory: Object.fromEntries(byCategory),
      recurringQuestions: [...grouped.values()].sort((a, b) => b.asked - a.asked).slice(0, 40),
      outcomes: Object.fromEntries(outcomes.map((o) => [o.outcome, o._count])),
    };
  });
}
