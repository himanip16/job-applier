import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { count, groupBy, updateMany, readConnectionPage, statusTotals, composeConnectionMessages } = vi.hoisted(() => ({
  count: vi.fn(), groupBy: vi.fn(), updateMany: vi.fn(),
  readConnectionPage: vi.fn(), statusTotals: vi.fn(), composeConnectionMessages: vi.fn(),
}));
vi.mock('../src/lib/db.js', () => ({ prisma: { contact: { count, groupBy, updateMany } } }));
vi.mock('../src/outreach/connectionStatus.js', () => ({ readConnectionPage, statusTotals }));
vi.mock('../src/outreach/connectionMessages.js', () => ({ composeConnectionMessages }));
import { registerConnectionRoutes } from '../src/routes/connections.js';

function app(profile: { id: string } | null = { id: 'my-profile' }) {
  const instance = Fastify();
  registerConnectionRoutes(instance, async (_req, reply) => {
    if (profile) return profile;
    reply.code(401).send({ error: 'Sign in required' });
    return null;
  });
  return instance;
}

describe('the connections list', () => {
  afterEach(() => vi.resetAllMocks());

  async function request(query: string, total = 53) {
    const instance = app();
    count.mockResolvedValue(total);
    groupBy.mockResolvedValue([{ role: 'OTHER', _count: { _all: total } }]);
    statusTotals.mockResolvedValue({ YOUR_TURN: 1, DRAFTED: 0, AWAITING_REPLY: 2, NOT_CONTACTED: 50, CLOSED: 0 });
    readConnectionPage.mockResolvedValue([{ id: 'sam', fullName: 'Sam', status: 'YOUR_TURN' }]);
    try { return await instance.inject(`/api/linkedin/connections${query}`); }
    finally { await instance.close(); }
  }

  it('sections by conversation status unless asked otherwise, and pages within the signed-in profile', async () => {
    const response = await request('?page=2&pageSize=25');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      page: 2, pageSize: 25, total: 53, totalPages: 3, sort: 'status',
      connections: [{ status: 'YOUR_TURN' }],
      statusTotals: { YOUR_TURN: 1, NOT_CONTACTED: 50 },
    });
    expect(readConnectionPage).toHaveBeenCalledWith({ profileId: 'my-profile', sort: 'status', skip: 25, take: 25 });
    expect(statusTotals).toHaveBeenCalledWith('my-profile');
  });

  it.each(['name', 'role', 'company'])('sections by %s when asked', async (sort) => {
    expect((await request(`?sort=${sort}`)).json()).toMatchObject({ sort });
    expect(readConnectionPage).toHaveBeenCalledWith(expect.objectContaining({ sort }));
  });

  it('clamps a page beyond the last page', async () => {
    expect((await request('?page=99&pageSize=25')).json()).toMatchObject({ page: 3, totalPages: 3 });
    expect(readConnectionPage).toHaveBeenCalledWith(expect.objectContaining({ skip: 50 }));
  });

  it('returns valid pagination for an empty list', async () => {
    expect((await request('?page=99', 0)).json()).toMatchObject({ page: 1, total: 0, totalPages: 1 });
    expect(readConnectionPage).toHaveBeenCalledWith(expect.objectContaining({ skip: 0 }));
  });

  it.each(['?page=0', '?page=-1', '?page=1.5', '?pageSize=101', '?pageSize=abc', '?sort=lastMessage'])(
    'rejects invalid pagination %s', async (query) => {
      expect((await request(query)).statusCode).toBe(400);
      expect(readConnectionPage).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    });

  it('does not read contacts without an authorized profile', async () => {
    const instance = app(null);
    try {
      expect((await instance.inject('/api/linkedin/connections')).statusCode).toBe(401);
      expect(readConnectionPage).not.toHaveBeenCalled();
    } finally { await instance.close(); }
  });
});

describe('marking a conversation done', () => {
  afterEach(() => vi.resetAllMocks());

  const close = (body: unknown, profile: { id: string } | null = { id: 'my-profile' }) =>
    app(profile).inject({ method: 'POST', url: '/api/linkedin/connections/c1/close', payload: body });

  it('stamps a date when closed and clears it when reopened', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    expect((await close({ closed: true })).json()).toEqual({ id: 'c1', closed: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', profileId: 'my-profile' },
      data: { conversationClosedAt: expect.any(Date) },
    });

    updateMany.mockClear();
    expect((await close({ closed: false })).json()).toEqual({ id: 'c1', closed: false });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { conversationClosedAt: null } }));
  });

  it('refuses to close a contact on someone else’s profile', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect((await close({ closed: true })).statusCode).toBe(404);
  });

  it('rejects a body that does not say which way', async () => {
    expect((await close({})).statusCode).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not close without an authorized profile', async () => {
    expect((await close({ closed: true }, null)).statusCode).toBe(401);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('drafting from a selection', () => {
  afterEach(() => vi.resetAllMocks());

  const post = (payload: unknown, profile: { id: string } | null = { id: 'my-profile' }) =>
    app(profile).inject({ method: 'POST', url: '/api/linkedin/connections/messages', payload });

  it('passes the selection through with the signed-in profile', async () => {
    composeConnectionMessages.mockResolvedValue({ created: [{ id: 'i1', contactId: 'c1' }], errors: [] });
    const response = await post({ contactIds: ['c1', 'c2'], mode: 'AI', emphasis: 'the payments work' });
    expect(response.statusCode).toBe(200);
    expect(composeConnectionMessages).toHaveBeenCalledWith({
      profileId: 'my-profile', contactIds: ['c1', 'c2'], mode: 'AI', emphasis: 'the payments work',
    });
  });

  it('refuses a written message with nothing in it', async () => {
    const response = await post({ contactIds: ['c1'], mode: 'TEMPLATE', body: '   ' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/write the message/i);
    expect(composeConnectionMessages).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty selection', { contactIds: [], mode: 'AI' }],
    ['more than one batch', { contactIds: Array.from({ length: 51 }, (_, i) => `c${i}`), mode: 'AI' }],
    ['an unknown mode', { contactIds: ['c1'], mode: 'MAGIC' }],
  ])('rejects %s', async (_label, payload) => {
    expect((await post(payload)).statusCode).toBe(400);
    expect(composeConnectionMessages).not.toHaveBeenCalled();
  });

  it('does not draft without an authorized profile', async () => {
    expect((await post({ contactIds: ['c1'], mode: 'AI' }, null)).statusCode).toBe(401);
    expect(composeConnectionMessages).not.toHaveBeenCalled();
  });
});
