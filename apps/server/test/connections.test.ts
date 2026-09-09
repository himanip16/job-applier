import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { count, findMany } = vi.hoisted(() => ({ count: vi.fn(), findMany: vi.fn() }));
vi.mock('../src/lib/db.js', () => ({ prisma: { contact: { count, findMany } } }));
import { registerConnectionRoutes } from '../src/routes/connections.js';

describe('paginated connections', () => {
  afterEach(() => vi.resetAllMocks());

  async function request(query: string, total = 53) {
    const app = Fastify();
    registerConnectionRoutes(app, async () => ({ id: 'my-profile' }));
    count.mockResolvedValue(total);
    findMany.mockResolvedValue([{ id: 'other-role', fullName: 'Sam', role: 'OTHER' }]);
    try { return await app.inject(`/api/linkedin/connections${query}`); }
    finally { await app.close(); }
  }

  it('paginates all roles within the signed-in profile using stable alphabetical order', async () => {
    const response = await request('?page=2&pageSize=25');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ page: 2, pageSize: 25, total: 53, totalPages: 3, connections: [{ role: 'OTHER' }] });
    expect(count).toHaveBeenCalledWith({ where: { profileId: 'my-profile', isConnection: true } });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { profileId: 'my-profile', isConnection: true }, skip: 25, take: 25,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    }));
  });

  it('clamps a page beyond the last page', async () => {
    const response = await request('?page=99&pageSize=25');
    expect(response.json()).toMatchObject({ page: 3, totalPages: 3 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50 }));
  });

  it('returns valid pagination for an empty list', async () => {
    const response = await request('?page=99', 0);
    expect(response.json()).toMatchObject({ page: 1, total: 0, totalPages: 1 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0 }));
  });

  it.each(['?page=0', '?page=-1', '?page=1.5', '?pageSize=101', '?pageSize=abc'])('rejects invalid pagination %s', async (query) => {
    expect((await request(query)).statusCode).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('does not read contacts without an authorized profile', async () => {
    const app = Fastify();
    registerConnectionRoutes(app, async (_req, reply) => {
      reply.code(401).send({ error: 'Sign in required' });
      return null;
    });
    try {
      expect((await app.inject('/api/linkedin/connections')).statusCode).toBe(401);
      expect(count).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
