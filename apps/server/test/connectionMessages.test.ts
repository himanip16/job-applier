import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  findMany: vi.fn(), findUniqueOrThrow: vi.fn(),
  findFirst: vi.fn(), create: vi.fn(), update: vi.fn(),
  generate: vi.fn(),
}));
vi.mock('../src/lib/db.js', () => ({
  prisma: {
    contact: { findMany: db.findMany },
    profile: { findUniqueOrThrow: db.findUniqueOrThrow },
    outreachItem: { findFirst: db.findFirst, create: db.create, update: db.update },
  },
}));
vi.mock('../src/llm/client.js', () => ({ generate: db.generate }));
import { composeConnectionMessages, personalise, unfillable } from '../src/outreach/connectionMessages.js';

const cara = {
  id: 'c1', fullName: 'Cara Nguyen', headline: 'Engineering Manager at Example Labs',
  companyName: 'Example Labs', role: 'ENGINEERING', isConnection: true,
};
const anon = { ...cara, id: 'c2', fullName: 'Sam Reed', headline: null, companyName: 'Unknown' };

beforeEach(() => {
  db.findMany.mockResolvedValue([cara, anon]);
  db.findUniqueOrThrow.mockResolvedValue({ id: 'p1', fullName: 'Ada', email: 'ada@example.com', facts: [], resumeText: null });
  db.findFirst.mockResolvedValue(null);
  db.create.mockImplementation(async () => ({ id: 'item-1' }));
  db.update.mockImplementation(async () => ({ id: 'item-1' }));
});
afterEach(() => vi.resetAllMocks());

describe('filling a written message in', () => {
  it('substitutes only the placeholders it knows', () => {
    expect(personalise('Hi {firstName}, still at {company}? {useState} stays.', cara))
      .toBe('Hi Cara, still at Example Labs? {useState} stays.');
  });

  it('reports a placeholder LinkedIn gave us nothing for', () => {
    expect(unfillable('Hi {firstName} at {company}', anon)).toEqual(['company']);
    expect(unfillable('Hi {firstName}', anon)).toEqual([]);
  });
});

describe('drafting from a selection', () => {
  it('uses the written message verbatim and never calls the model', async () => {
    const result = await composeConnectionMessages({
      profileId: 'p1', contactIds: ['c1'], mode: 'TEMPLATE', body: '  Hi {firstName}, are you hiring?  ',
    });
    expect(db.generate).not.toHaveBeenCalled();
    expect(result.created).toEqual([{ id: 'item-1', contactId: 'c1', fullName: 'Cara Nguyen', charLimit: 8000, overLimit: false }]);
    expect(db.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        draftBody: 'Hi Cara, are you hiring?', status: 'DRAFT', type: 'COLD', jobUrl: '', channel: 'DIRECT_MESSAGE',
      }),
    }));
  });

  it('keeps drafting the rest when one person cannot be written for', async () => {
    const result = await composeConnectionMessages({
      profileId: 'p1', contactIds: ['c1', 'c2'], mode: 'TEMPLATE', body: 'Hi {firstName} at {company}',
    });
    expect(result.created.map((made) => made.contactId)).toEqual(['c1']);
    expect(result.errors).toEqual([{ contactId: 'c2', fullName: 'Sam Reed', error: expect.stringContaining('{company}') }]);
  });

  it('writes one model call per person and reads the candidate context once', async () => {
    db.generate.mockResolvedValue({ body: ' Hi Cara, I am looking. ', claimsMade: [], unsupportedClaims: [] });
    const result = await composeConnectionMessages({ profileId: 'p1', contactIds: ['c1', 'c2'], mode: 'AI' });
    expect(db.generate).toHaveBeenCalledTimes(2);
    expect(db.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(result.created).toHaveLength(2);
    expect(db.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ draftBody: 'Hi Cara, I am looking.' }),
    }));
  });

  it('reports a model that declines rather than saving an empty draft', async () => {
    db.generate.mockResolvedValue(null);
    const result = await composeConnectionMessages({ profileId: 'p1', contactIds: ['c1'], mode: 'AI' });
    expect(result.created).toEqual([]);
    expect(result.errors[0]?.error).toMatch(/declined/i);
    expect(db.create).not.toHaveBeenCalled();
  });

  it('flags a written message longer than the channel allows without truncating it', async () => {
    db.findMany.mockResolvedValue([{ ...cara, isConnection: false }]);
    const result = await composeConnectionMessages({
      profileId: 'p1', contactIds: ['c1'], mode: 'TEMPLATE', body: 'x'.repeat(400),
    });
    expect(result.created[0]).toMatchObject({ charLimit: 300, overLimit: true });
    expect(db.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ draftBody: 'x'.repeat(400), channel: 'CONNECTION_NOTE' }),
    }));
  });

  it('overwrites an untouched draft, dropping the edit that belonged to the old one', async () => {
    db.findFirst.mockResolvedValue({ id: 'old', status: 'DRAFT' });
    await composeConnectionMessages({ profileId: 'p1', contactIds: ['c1'], mode: 'TEMPLATE', body: 'Hi {firstName}' });
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'old' },
      data: expect.objectContaining({ draftBody: 'Hi Cara', finalBody: null, editedAt: null }),
    }));
  });

  it.each([
    ['SENT', /already sent/i],
    ['APPROVED', /already approved/i],
  ])('refuses to rewrite a message that is %s', async (status, expected) => {
    db.findFirst.mockResolvedValue({ id: 'old', status });
    const result = await composeConnectionMessages({ profileId: 'p1', contactIds: ['c1'], mode: 'TEMPLATE', body: 'Hi' });
    expect(result.created).toEqual([]);
    expect(result.errors[0]?.error).toMatch(expected);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses a contact that is not on the profile', async () => {
    db.findMany.mockResolvedValue([]);
    const result = await composeConnectionMessages({ profileId: 'p1', contactIds: ['someone-elses'], mode: 'TEMPLATE', body: 'Hi' });
    expect(result.errors[0]?.error).toMatch(/not on your profile/i);
    expect(db.create).not.toHaveBeenCalled();
  });

  it('refuses an empty written message before touching the database', async () => {
    await expect(composeConnectionMessages({ profileId: 'p1', contactIds: ['c1'], mode: 'TEMPLATE', body: '   ' }))
      .rejects.toThrow(/write the message/i);
    expect(db.create).not.toHaveBeenCalled();
  });
});
