import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyHardRules,
  candidateConstraints,
  experienceVerdict,
  parseRequiredYears,
  parseYears,
  offDomainVerdict,
  sponsorshipVerdict,
} from '../src/discovery/hardRules.js';
import { blendScores, type FitAssessment, type LexicalScore } from '../src/discovery/scoring.js';

/**
 * The two answers a model talks itself out of.
 *
 * Asked to judge fit, it will call seven years "a stretch, but the domain
 * overlap is strong" for a four-and-a-half-year candidate, and it will read a
 * US posting that says nothing about visas as though silence were an open
 * door. Both are rules, not judgement calls.
 */

const ME = { candidateYears: 4.5, needsSponsorship: true };

describe('reading years out of prose', () => {
  it('keeps the decimal', () => {
    // The old pattern captured only the digits before the point, so 4.5 read
    // as 4 and every posting asking for 5 became a shortfall it did not have.
    expect(parseYears('4.5 years of professional experience')).toBe(4.5);
    expect(parseYears('4.5+ years experience')).toBe(4.5);
    expect(parseYears('Experience: 6 years')).toBe(6);
  });

  it('takes the hardest requirement in the list, not the first', () => {
    const posting =
      '3+ years of Python. 7+ years building distributed systems. 2 years of mentoring.';
    expect(parseRequiredYears(posting)).toBe(7);
  });

  it('ignores prose that merely mentions years', () => {
    expect(parseRequiredYears('We were founded 12 years ago.')).toBeNull();
    expect(parseRequiredYears('No numbers here at all.')).toBeNull();
  });
});

describe('the experience bar', () => {
  const verdict = (required: string) => experienceVerdict(4.5, required);

  it('lets half a year either way pass without comment', () => {
    expect(verdict('5 years of experience required')).toBeNull();
    expect(verdict('4 years of experience required')).toBeNull();
    expect(verdict('3+ years of experience')).toBeNull();
  });

  it('notes a small gap without blocking', () => {
    const v = verdict('Looking for 5.5+ years of experience');
    expect(v?.dealbreaker).toBeUndefined();
    expect(v?.against).toMatch(/under the experience bar/i);
  });

  it('blocks anything more than a year over', () => {
    // The case that prompted this: 7 years asked, 4.5 held.
    const v = verdict('Senior role: 7+ years of backend experience required');
    expect(v?.dealbreaker).toMatch(/7\+? years/);
    expect(v?.against).toMatch(/2.5 years/);

    expect(verdict('6+ years required')?.dealbreaker).toBeTruthy();
    // 5.5 is exactly a year over: still only a note, by the rule.
    expect(verdict('5.5+ years required')?.dealbreaker).toBeUndefined();
  });

  it('says nothing when either side is unknown', () => {
    expect(experienceVerdict(null, '7+ years required')).toBeNull();
    expect(experienceVerdict(4.5, 'A great opportunity for a backend engineer.')).toBeNull();
  });
});

describe('visa sponsorship on US postings', () => {
  const job = (location: string, descriptionText: string) => ({
    title: 'Senior Backend Engineer',
    location,
    descriptionText,
  });

  it('blocks a US role that never mentions it', () => {
    // The candidate's own rule, and the right way round: the cost of wrongly
    // skipping one opening is not the cost of wrongly applying to fifty.
    const v = sponsorshipVerdict(true, job('San Francisco, CA', 'Build our payments platform in Go.'));
    expect(v?.dealbreaker).toMatch(/never mentions/i);
  });

  it('blocks a US role that rules it out in words', () => {
    const v = sponsorshipVerdict(
      true,
      job('Remote - US', 'You must be legally authorized to work in the United States. No visa sponsorship.'),
    );
    expect(v?.dealbreaker).toMatch(/says outright/i);
  });

  it('allows a US role that says it sponsors', () => {
    for (const line of [
      'Visa sponsorship is available for this role.',
      'We will sponsor H-1B transfers for the right candidate.',
      'Sponsorship offered.',
    ]) {
      expect(sponsorshipVerdict(true, job('New York, NY', line))?.dealbreaker).toBeUndefined();
    }
    expect(sponsorshipVerdict(true, job('Austin, TX', 'Visa sponsorship is available.'))?.for).toBeTruthy();
  });

  it('allows a US company hiring into India', () => {
    const v = sponsorshipVerdict(
      true,
      job('New York, NY', 'This role is open to candidates from India, working remotely.'),
    );
    expect(v).toBeNull();
  });

  it('leaves postings outside the US alone', () => {
    expect(sponsorshipVerdict(true, job('Bengaluru, India', 'Build things.'))).toBeNull();
    expect(sponsorshipVerdict(true, job('London, UK', 'Build things.'))).toBeNull();
    expect(sponsorshipVerdict(true, job('Remote - EMEA', 'Build things.'))).toBeNull();
  });

  it('does not apply to somebody who does not need it', () => {
    expect(sponsorshipVerdict(false, job('San Francisco, CA', 'Build things.'))).toBeNull();
  });

  it('reads the candidate as needing it from where they are', () => {
    expect(candidateConstraints({ countryCode: 'IN', country: 'India' }).needsSponsorship).toBe(true);
    expect(candidateConstraints({ countryCode: 'US', country: 'United States' }).needsSponsorship).toBe(false);
    expect(candidateConstraints({ country: 'USA' }).needsSponsorship).toBe(false);
  });

  it('prefers a stated fact for years over a regex across the resume', () => {
    const c = candidateConstraints({
      facts: [{ key: 'experience.years', value: '4.5' }],
      // A bullet that would otherwise be read as the answer.
      resumeText: 'Led a 3 years long migration of the billing system.',
    });
    expect(c.candidateYears).toBe(4.5);
  });
});

describe('what the rules do to a score', () => {
  const fit = (score: number): FitAssessment => ({
    score,
    verdict: 'STRONG',
    forIt: ['Strong domain overlap'],
    againstIt: [],
    seniorityFit: 'MATCH',
    dealbreaker: '',
  });
  const noOpinion: LexicalScore = {
    score: 50, positives: [], negatives: [], affinity: 0.35, shared: [], missing: [], confidence: 0,
  };

  it('turns an enthusiastic 90 into a no, not into a 33', () => {
    // Subtracting from the score is a negotiation: it left this posting
    // outranking jobs that were genuinely open.
    const job = {
      title: 'Staff Engineer',
      location: 'San Francisco, CA',
      descriptionText: '8+ years of experience required. Visa sponsorship is available.',
    };
    const ruled = applyHardRules(fit(90), { ...ME, job });
    expect(ruled.verdict).toBe('MISMATCH');
    expect(blendScores(ruled, noOpinion)).toBeLessThanOrEqual(15);
  });

  it('stacks both blockers into one honest sentence', () => {
    const job = {
      title: 'Staff Engineer',
      location: 'Seattle, WA',
      descriptionText: '9+ years of experience. Build our platform.',
    };
    const ruled = applyHardRules(fit(88), { ...ME, job });
    expect(ruled.dealbreaker).toMatch(/9\+? years/);
    expect(ruled.dealbreaker).toMatch(/never mentions/i);
    expect(ruled.againstIt.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves a job that clears both rules exactly as the model scored it', () => {
    const job = {
      title: 'Senior Backend Engineer',
      location: 'Bengaluru, India',
      descriptionText: '4+ years of experience with Go and Postgres.',
    };
    const ruled = applyHardRules(fit(86), { ...ME, job });
    expect(ruled.dealbreaker).toBe('');
    expect(ruled.verdict).toBe('STRONG');
    expect(blendScores(ruled, noOpinion)).toBe(86);
  });

  it('keeps the model’s own blocker when it found one', () => {
    const withBlocker: FitAssessment = { ...fit(70), dealbreaker: 'Requires US security clearance.' };
    const job = { title: 'Engineer', location: 'Bengaluru, India', descriptionText: '9+ years.' };
    expect(applyHardRules(withBlocker, { ...ME, job }).dealbreaker).toBe('Requires US security clearance.');
  });
});


describe('jobs in another profession', () => {
  const drops = (title: string) => Boolean(offDomainVerdict(title));

  it('drops the ones that share a word with engineering and nothing else', () => {
    // A keyword scorer sees "Talent Acquisition Partner - Engineering" sharing
    // "engineering" with the resume, and a model asked whether it fits hedges.
    for (const title of [
      'Talent Acquisition Partner - Engineering',
      'Technical Recruiter',
      'Sales Development Representative',
      'Senior Account Executive - Credit & Lending Products',
      'Senior Product Marketing Manager - Cards & Spend Management',
      'Content Marketer',
      'Customer Success Manager',
      'Senior Internal Auditor - Finance',
      'Counsel, Product & Regulatory - Payments & AML',
      'Staff Visual Designer - Design Systems',
      'Senior Product Designer - Cards & Credit',
      'Senior Product Manager - Users',
      'Senior Strategic Partnerships Manager - Enterprise',
      'Technical Program Manager',
      'Office Manager',
    ]) {
      expect(drops(title), title).toBe(true);
    }
  });

  it('keeps engineering roles whatever team they serve', () => {
    // "Software Engineer, Marketing Platform" is not a marketing job. The
    // difference is whether the discipline is the noun or the qualifier.
    for (const title of [
      'Senior Backend Engineer - Product',
      'Software Engineer - Infrastructure',
      'Software Engineer, Marketing Platform',
      'Senior Data Engineer, Sales Analytics',
      'Staff Platform Engineer',
      'Senior Full-Stack Engineer',
      'Head of Data Engineering & Platform',
      'Site Reliability Engineer',
      'Engineer, Payments',
      'Backend Developer',
    ]) {
      expect(drops(title), title).toBe(false);
    }
  });

  it('leaves nothing but technical roles on a real board', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const { titles } = JSON.parse(
      readFileSync(path.resolve(here, '../../../fixtures/mercury-board-titles.json'), 'utf8'),
    ) as { titles: string[] };

    const kept = titles.filter((t) => !drops(t));
    // Fifty-five real openings; a backend engineer could hold about a sixth.
    expect(kept.length).toBeGreaterThan(8);
    expect(kept.length).toBeLessThan(22);
    for (const title of kept) {
      expect(title, `kept: ${title}`).toMatch(
        /engineer|developer|architect|technolog|infrastructure|platform|security|data|technical/i,
      );
    }
  });

  it('reads as a blocker, with the profession named', () => {
    const v = offDomainVerdict('Senior Recruiter');
    expect(v?.dealbreaker).toMatch(/recruiting role/i);
    expect(v?.against).toMatch(/Senior Recruiter/);
  });
});
