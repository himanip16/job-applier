import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/llm/client.js', () => ({
  generate: vi.fn(),
  isConfigured: () => true,
  describeLlmError: (error: unknown) => String(error),
}));

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();
const { prisma } = await import('../src/lib/db.js');
const { generate } = await import('../src/llm/client.js');
const { deepScoreLeads } = await import('../src/discovery/deepScore.js');
const { rescoreLeads, rescoreLexically } = await import('../src/discovery/rescoreLeads.js');
const { buildRejectionHistory } = await import('../src/discovery/scoring.js');
const { buildSearchPlan } = await import('../src/discovery/searchQueries.js');

let profileId: string;
beforeEach(async () => {
  vi.mocked(generate).mockReset();
  vi.mocked(generate).mockResolvedValue({
    score: 10, verdict: 'MISMATCH', forIt: [], againstIt: ['Poor fit'],
    seniorityFit: 'MATCH', compensationFit: 'UNCLEAR', dealbreaker: '',
  });
  const profile = await prisma.profile.create({ data: {
    email: `decisions-${Date.now()}-${Math.random()}@example.com`,
    fullName: 'Test Person', firstName: 'Test', lastName: 'Person', countryCode: 'IN',
    resumeText: 'Backend engineer with 4 years of experience building backend services in Go and Postgres.',
  } });
  profileId = profile.id;
});

afterEach(async () => {
  if (profileId) await prisma.profile.delete({ where: { id: profileId } });
});

const makeLead = (data: { title?: string; status?: 'NEW' | 'SHORTLISTED' | 'APPLIED' | 'REJECTED'; rejectReason?: string | null; decidedAt?: Date }) =>
  prisma.jobLead.create({ data: {
    profileId, url: `https://example.com/${Math.random()}`, ats: 'test', companyName: 'Test',
    title: 'Backend Engineer', location: 'Bengaluru, India', remote: false,
    descriptionText: 'Build backend services in Go and Postgres.', ...data,
  } });

describe('scores are not candidate decisions', () => {
  it('keeps low-scoring new leads and preserves their lexical explanations', async () => {
    const lead = await makeLead({});
    const result = await deepScoreLeads(profileId, [{ id: lead.id, lexScore: 70, job: {
      ...lead, descriptionText: lead.descriptionText!, location: lead.location!, postedAt: undefined,
    } }], 15);
    const saved = await prisma.jobLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(result.deepScored).toBe(1);
    expect(saved.score).toBeLessThan(55);
    expect(saved.status).toBe('NEW');
    expect(saved.decidedAt).toBeNull();
    expect(saved.rejectReason).toBeNull();
    expect(saved.scoreReasons).toMatchObject({ verdict: 'MISMATCH', sharedTerms: expect.arrayContaining(['backend']) });
  });

  it.each(['NEW', 'SHORTLISTED', 'APPLIED', 'REJECTED'] as const)('rescoring preserves %s and its decision metadata', async (status) => {
    const decidedAt = status === 'NEW' ? undefined : new Date('2026-01-01');
    const lead = await makeLead({ status, decidedAt, rejectReason: status === 'REJECTED' ? 'My own reason' : null });
    const result = await rescoreLeads(profileId, [lead]);
    expect(result[0]).toMatchObject({ ok: true, score: expect.any(Number) });
    const saved = await prisma.jobLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(saved.status).toBe(status);
    expect(saved.decidedAt).toEqual(lead.decidedAt);
    expect(saved.rejectReason).toBe(lead.rejectReason);
  });

  it('keeps an irrelevant job reviewable after a lexical rescore', async () => {
    const lead = await makeLead({ title: 'Technical Recruiter' });
    await rescoreLexically(profileId);
    const saved = await prisma.jobLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(saved.status).toBe('NEW');
    expect(saved.decidedAt).toBeNull();
  });

  it('excludes legacy automatic dismissals from both preference prompts before applying history limits', async () => {
    await makeLead({ title: 'Human choice', status: 'REJECTED', rejectReason: 'I prefer remote', decidedAt: new Date('2025-01-01') });
    await makeLead({ title: 'Human without reason', status: 'REJECTED', decidedAt: new Date('2025-01-02') });
    for (let i = 0; i < 16; i++) {
      await makeLead({ title: `Automatic ${i}`, status: 'REJECTED', decidedAt: new Date(),
        rejectReason: i % 2 ? 'Auto-rejected: deep score below 55' : 'Auto-dismissed: wrong domain' });
    }
    const history = await buildRejectionHistory(profileId, 2);
    expect(history).toContain('Human choice');
    expect(history).toContain('Human without reason');
    expect(history).not.toContain('Automatic');

    vi.mocked(generate).mockResolvedValue({ roleTitles: ['Backend Engineer'], queries: ['backend engineer india'] });
    await buildSearchPlan(profileId);
    const prompt = vi.mocked(generate).mock.calls.at(-1)![0].prompt;
    expect(prompt).toContain('Human choice');
    expect(prompt).toContain('Human without reason');
    expect(prompt).not.toContain('Automatic');
  });
});
