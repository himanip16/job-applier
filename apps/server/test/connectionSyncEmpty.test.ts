import { describe, expect, it, vi } from 'vitest';

const { page, syncUpsert, contactUpsert, openLinkedIn } = vi.hoisted(() => ({
  page: { evaluate: vi.fn().mockResolvedValue([]), close: vi.fn() },
  syncUpsert: vi.fn().mockResolvedValue({}),
  contactUpsert: vi.fn(),
  openLinkedIn: vi.fn(),
}));

vi.mock('../src/lib/db.js', () => ({
  prisma: {
    linkedInSync: { upsert: syncUpsert },
    contact: { upsert: contactUpsert },
    profile: { findUnique: vi.fn().mockResolvedValue({ linkedinConnectionStatus: 'CONNECTED' }) },
  },
}));
vi.mock('../src/linkedin/session.js', () => ({
  linkedInPage: vi.fn().mockResolvedValue(page), openLinkedIn, scrollToLoad: vi.fn(),
}));
vi.mock('../src/linkedin/connectionReader.js', () => ({ readConnections: vi.fn().mockResolvedValue([]) }));

import { syncConnections } from '../src/linkedin/sync.js';

describe('empty connection sync', () => {
  it('reports failure and preserves the page for inspection when no cards can be read', async () => {
    const result = await syncConnections('owner-profile');
    expect(result.synced).toBe(0);
    expect(result.errors[0]).toContain('No LinkedIn connections could be read');
    expect(contactUpsert).not.toHaveBeenCalled();
    expect(syncUpsert).toHaveBeenLastCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: 'FAILED' }),
    }));
    expect(page.close).not.toHaveBeenCalled();
    expect(openLinkedIn).toHaveBeenCalledWith(page, 'https://www.linkedin.com/mynetwork/invite-connect/connections/');
  });
});
