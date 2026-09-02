import { describe, expect, it } from 'vitest';
import { defaultOutreach } from '../src/outreach/draft.js';

describe('default LinkedIn outreach', () => {
  const base = {
    candidateContext: 'Name: Himani Sharma\n\nSummary: Backend engineer',
    contactFirstName: 'Alex',
    companyName: 'Acme',
    jobTitle: 'Software Engineer',
    channel: 'DIRECT_MESSAGE' as const,
  };

  it('asks talent contacts for an interview', () => {
    const draft = defaultOutreach({ ...base, contactRole: 'TALENT' });
    expect(draft.body).toContain('interview');
    expect(draft.body).toContain('Software Engineer');
    expect(draft.body).toContain('Himani Sharma');
  });

  it('asks other contacts for a referral', () => {
    const draft = defaultOutreach({ ...base, contactRole: 'ENGINEERING' });
    expect(draft.body).toContain('referring me');
    expect(draft.body).toContain('Acme');
  });
});
