import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { upsert, currentUser } = vi.hoisted(() => ({
  upsert: vi.fn(),
  currentUser: vi.fn(),
}));

vi.mock('../src/lib/db.js', () => ({ prisma: { profile: { upsert } } }));
vi.mock('../src/auth/sessions.js', () => ({ currentUser }));

import { registerProfileRoutes } from '../src/routes/profile.js';

describe('single-name profile setup', () => {
  afterEach(() => vi.resetAllMocks());

  it.each(['', undefined])('saves a profile with surname %s without inventing one', async (lastName) => {
    const app = Fastify();
    registerProfileRoutes(app, vi.fn());
    currentUser.mockResolvedValue({ id: 'owner', email: 'person@example.com' });
    upsert.mockImplementation(async ({ create }) => ({ id: 'profile', ...create }));
    try {
      const response = await app.inject({
        method: 'PUT', url: '/api/profile',
        payload: { email: 'person@example.com', fullName: 'Himani', firstName: 'Himani', lastName },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().profile).toMatchObject({ userId: 'owner', fullName: 'Himani', lastName: '' });
    } finally { await app.close(); }
  });

  it('still rejects a missing first name', async () => {
    const app = Fastify();
    registerProfileRoutes(app, vi.fn());
    currentUser.mockResolvedValue({ id: 'owner', email: 'person@example.com' });
    try {
      const response = await app.inject({
        method: 'PUT', url: '/api/profile',
        payload: { email: 'person@example.com', fullName: 'Himani', firstName: '', lastName: '' },
      });
      expect(response.statusCode).toBe(400);
      expect(upsert).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
