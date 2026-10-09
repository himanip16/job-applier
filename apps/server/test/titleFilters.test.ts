import { describe, expect, it } from 'vitest';
import { isSeniorLevel } from '../src/discovery/jobFilters.js';

/**
 * The title gates, read without a database: nothing here writes or deletes.
 *
 * Both gates fail silently - a posting they drop never reaches the queue - so
 * the cases are the titles real boards post under other names.
 */

// searchQueries imports the Prisma client; under vitest that refuses anything
// but a _test database, and building it runs no query.
const { titleMatchesPlan, normalizeTitle, jobMatchesPlan } = await import('../src/discovery/searchQueries.js');

describe('one vocabulary for titles', () => {
  it('reads SDE, MTS and Developer as the engineer titles they are', () => {
    expect(normalizeTitle('SDE-2')).toBe('software engineer');
    expect(normalizeTitle('SDE II, Payments')).toBe('software engineer payments');
    expect(normalizeTitle('Software Development Engineer')).toBe('software engineer');
    expect(normalizeTitle('Member of Technical Staff')).toBe('software engineer');
    expect(normalizeTitle('SMTS')).toBe('senior software engineer');
    expect(normalizeTitle('Backend Developer')).toBe('backend engineer');
  });

  it('matches plans and postings that name the same job differently', () => {
    expect(titleMatchesPlan('SDE-2', ['Software Engineer'])).toBe(true);
    expect(titleMatchesPlan('Backend Developer', ['Backend Engineer'])).toBe(true);
    expect(titleMatchesPlan('MTS 2', ['Software Engineer'])).toBe(true);
    expect(titleMatchesPlan('SMTS', ['Senior Software Engineer'])).toBe(true);
    expect(titleMatchesPlan('Backend Engineer', ['Backend Developer'])).toBe(true);
  });

  it('does not widen into other jobs', () => {
    expect(titleMatchesPlan('SDET', ['Software Engineer'])).toBe(false);
    expect(titleMatchesPlan('Frontend Developer', ['Backend Engineer'])).toBe(false);
    expect(titleMatchesPlan('Technical Recruiter', ['Software Engineer'])).toBe(false);
  });

  it('matches spelling variants and generic engineering levels', () => {
    expect(titleMatchesPlan('Back-end Developer II', ['Backend Engineer'])).toBe(true);
    expect(titleMatchesPlan('Full Stack Engineer', ['Fullstack Developer'])).toBe(true);
    expect(titleMatchesPlan('SDE II', ['Senior Software Engineer'])).toBe(true);
    expect(titleMatchesPlan('Recruiter', ['Senior'])).toBe(false);
  });

  it('uses responsibilities when a software title does not name its speciality', () => {
    expect(jobMatchesPlan({ title: 'Software Engineer II', descriptionText: 'Build server-side services in Go.' }, ['Backend Engineer'])).toBe(true);
    expect(jobMatchesPlan({ title: 'MTS 2', descriptionText: 'Own our backend payment services.' }, ['Backend Engineer'])).toBe(true);
    expect(jobMatchesPlan({ title: 'Software Engineer II', descriptionText: 'Build user interfaces in React.' }, ['Backend Engineer'])).toBe(false);
    expect(jobMatchesPlan({ title: 'Software Engineer II' }, ['Backend Engineer'])).toBe(false);
  });

  it('does not let incidental description keywords override a different role', () => {
    for (const title of ['Frontend Engineer', 'Technical Recruiter', 'Sales Engineer', 'Counsel, Payments']) {
      expect(jobMatchesPlan({ title, descriptionText: 'Work alongside backend software engineers.' }, ['Backend Engineer'])).toBe(false);
    }
  });
});

describe('the seniority gate', () => {
  it('matches whole words, not pieces of them', () => {
    expect(isSeniorLevel('Staff Software Engineer')).toBe(true);
    expect(isSeniorLevel('Staffing Platform Engineer')).toBe(false);
    expect(isSeniorLevel('Connectors Engineer')).toBe(false);
  });

  it('does not read Member of Technical Staff as the staff level', () => {
    expect(isSeniorLevel('Member of Technical Staff')).toBe(false);
    expect(isSeniorLevel('SMTS, Platform')).toBe(false);
    expect(isSeniorLevel('Principal MTS')).toBe(true);
    expect(isSeniorLevel('LMTS')).toBe(true);
    expect(isSeniorLevel('Lead Member of Technical Staff')).toBe(true);
  });

  it('only counts "manager" in the role, not the team', () => {
    expect(isSeniorLevel('Software Engineer – Package Manager')).toBe(false);
    expect(isSeniorLevel('Software Engineer, Package Manager')).toBe(false);
    expect(isSeniorLevel('Engineering Manager – Payments')).toBe(true);
    expect(isSeniorLevel('Engineering Manager, Payments')).toBe(true);
    expect(isSeniorLevel('Full-Stack Engineering Manager')).toBe(true);
  });
});
