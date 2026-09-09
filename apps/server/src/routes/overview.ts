import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/db.js';
import { currentUser } from '../auth/sessions.js';
import { isConfigured, provider } from '../llm/client.js';
import { activeModels } from '../llm/models.js';
import { isFirecrawlConfigured } from '../discovery/firecrawl.js';
import { cachedSchemaProblem } from '../lib/schemaCheck.js';
import { config } from '../lib/config.js';
import { estimateActivityCosts } from '../llm/models.js';
import { activeRuns } from '../engine/queue.js';
import type { RequireUser } from '../auth/requireProfile.js';

async function safeCount(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch {
    return 0;
  }
}

export function registerOverviewRoutes(app: FastifyInstance) {
  app.get('/api/overview', async (req) => {
    const user = await currentUser(req);
    const profile = user
      ? await prisma.profile.findUnique({
          where: { userId: user.id },
          include: { facts: true, resumes: true, _count: { select: { answers: true } } },
        })
      : null;

    const [
      companies,
      leadsNew,
      needsInput,
      needsHuman,
      inReview,
      submitted,
      upcomingRounds,
      lessons,
      strongMatches,
      leadsTotal,
      shortlisted,
      runsInFlight,
      notApplied,
    ] =
      await Promise.all([
        safeCount(() => prisma.company.count({ where: { enabled: true } })),
        profile
          ? safeCount(() => prisma.jobLead.count({ where: { profileId: profile.id, status: 'NEW' } }))
          : 0,
        profile
          ? safeCount(() => prisma.application.count({ where: { profileId: profile.id, status: 'NEEDS_INPUT' } }))
          : 0,
        profile
          ? safeCount(() => prisma.application.count({ where: { profileId: profile.id, status: 'NEEDS_HUMAN' } }))
          : 0,
        profile
          ? safeCount(() => prisma.application.count({ where: { profileId: profile.id, status: 'REVIEW' } }))
          : 0,
        profile
          ? safeCount(() => prisma.application.count({ where: { profileId: profile.id, status: 'SUBMITTED' } }))
          : 0,
        profile
          ? safeCount(() =>
              prisma.interviewRound.count({
                where: { application: { profileId: profile.id }, status: 'SCHEDULED' },
              }),
            )
          : 0,
        profile
          ? safeCount(() => prisma.lesson.count({ where: { application: { profileId: profile.id } } }))
          : 0,
        safeCount(() =>
          profile
            ? prisma.jobLead.count({ where: { profileId: profile.id, status: 'NEW', score: { gte: 70 } } })
            : Promise.resolve(0),
        ),
        safeCount(() => (profile ? prisma.jobLead.count({ where: { profileId: profile.id } }) : Promise.resolve(0))),
        profile
          ? safeCount(() => prisma.jobLead.count({ where: { profileId: profile.id, status: 'SHORTLISTED' } }))
          : 0,
        profile
          ? safeCount(() =>
              prisma.application.count({
                where: {
                  profileId: profile.id,
                  status: { in: ['QUEUED', 'PREPARING', 'FILLING', 'SUBMITTING'] },
                  updatedAt: { gt: new Date(Date.now() - 10 * 60_000) },
                },
              }),
            )
          : 0,
        safeCount(() =>
          profile
            ? prisma.jobLead.count({
                where: { profileId: profile.id, status: { in: ['NEW', 'SHORTLISTED'] } },
              })
            : Promise.resolve(0),
        ),
      ]);

    const topMatches = profile
      ? await prisma.jobLead
          .findMany({
            where: { profileId: profile.id, status: { in: ['NEW', 'SHORTLISTED'] } },
            orderBy: [{ score: 'desc' }, { discoveredAt: 'desc' }],
            take: 6,
            select: {
              id: true,
              title: true,
              companyName: true,
              location: true,
              remote: true,
              score: true,
              deepScored: true,
              status: true,
              url: true,
            },
          })
          .catch(() => [])
      : [];

    const schema = await cachedSchemaProblem();

    const urgent = profile
      ? await prisma.application
          .findFirst({
            where: { profileId: profile.id, status: { in: ['NEEDS_INPUT', 'NEEDS_HUMAN', 'REVIEW'] } },
            orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
            include: { job: { select: { title: true, company: true } } },
          })
          .catch(() => null)
      : null;

    const standingAnswers = profile?.facts.length ?? 0;

    const setup = [
      {
        id: 'schema',
        label: 'Sync the database',
        done: schema === null,
        detail: schema ?? 'Client, schema and tables all match.',
        href: null,
      },
      {
        id: 'model',
        label: 'Connect a model',
        done: isConfigured(),
        detail: isConfigured()
          ? `${activeModels().provider} · ${activeModels().writing}`
          : 'Gemini has a free tier. Paste the key on the settings page — no restart needed.',
        href: '/settings',
      },
      {
        id: 'profile',
        label: 'Fill in your profile',
        done: Boolean(profile?.email && profile?.fullName),
        detail: profile ? `${profile.fullName} · ${profile.email}` : 'Name, contact and links fill half of every form directly.',
        href: '/profile',
      },
      {
        id: 'resume',
        label: 'Upload your resume',
        done: (profile?.resumes.length ?? 0) > 0,
        detail: profile?.resumes.length
          ? `${profile.resumes.length} on file`
          : 'Attached to applications, and the only thing claims can be grounded in.',
        href: '/profile',
      },
      {
        id: 'facts',
        label: 'Answer the standing questions',
        done: standingAnswers >= 5,
        detail:
          standingAnswers >= 5
            ? `${standingAnswers} recorded`
            : `${standingAnswers} of ~11 filled. Each one is a popup you will not see later.`,
        href: '/profile',
      },
      {
        id: 'search',
        label: 'Turn on job search',
        done: isFirecrawlConfigured(),
        detail: isFirecrawlConfigured()
          ? companies > 0
            ? `Ready. ${companies} board(s) found so far.`
            : 'Ready. Hit "Find jobs for me" and it will go looking.'
          : 'Paste a Firecrawl key on the settings page and it will find openings on its own.',
        href: '/settings',
      },
    ];

    return {
      setup,
      ready: setup.slice(0, 4).every((s) => s.done),
      needsYou: {
        needsInput,
        inReview,
        needsHuman,
        total: needsInput + inReview + needsHuman,
        first: urgent
          ? {
              id: urgent.id,
              status: urgent.status,
              title: urgent.job.title,
              company: urgent.job.company,
              reason: urgent.blockedReason,
            }
          : null,
      },
      counts: {
        leadsNew,
        leadsTotal,
        strongMatches,
        shortlisted,
        submitted,
        upcomingRounds,
        lessons,
        answerBank: profile?._count.answers ?? 0,
        runsInFlight,
        companies,
        notApplied,
      },
      topMatches,
    };
  });

  app.get('/api/models', async () => {
    try {
      const p = provider();
      return { provider: p.id, models: await p.listModels(), active: activeModels() };
    } catch (err) {
      return { provider: null, models: [], error: (err as Error).message };
    }
  });

  /**
   * Detailed system information - requires authentication.
   *
   * This provides the health check details that were previously exposed publicly,
   * now protected behind authentication for security.
   */
  app.get('/api/system', async (req, reply) => {
    const user = await currentUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in to use this.' });

    return {
      llmConfigured: isConfigured(),
      searchConfigured: isFirecrawlConfigured(),
      ...activeModels(),
      // Rough, local, and always an estimate - the real figure is on your console.
      estimatedCosts: estimateActivityCosts(),
      headless: config.headless,
      requireReview: config.requireReview,
      activeRuns: activeRuns(),
    };
  });
}
