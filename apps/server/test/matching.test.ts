import { describe, expect, it } from 'vitest';
import { matchCanonical, normalizeLabel, vectorize, cosine, optionsCompatible } from '@ja/shared';
import { matchOption, findDeclineOption } from '../src/engine/optionMatch.js';
import { scoreExperienceFit } from '../src/discovery/scoring.js';

describe('canonical question matching', () => {
  it('recognises the same question across wordings and spellings', () => {
    const authorized = [
      'Are you legally authorized to work in the United States?',
      'Are you legally authorised to work in the UK? *',
      'Do you have the right to work in Ireland?',
      'Are you eligible to work in this country?',
    ];
    for (const label of authorized) {
      expect(matchCanonical(label)?.key, label).toBe('work_auth.authorized');
    }
  });

  it('keeps authorisation and sponsorship apart', () => {
    // These two get conflated constantly, and answering one with the other's
    // answer is exactly the kind of mistake that sinks an application.
    expect(matchCanonical('Are you legally authorized to work in the US?')?.key)
      .toBe('work_auth.authorized');
    expect(matchCanonical('Will you now or in the future require sponsorship for a work visa?')?.key)
      .toBe('work_auth.sponsorship_required');
    expect(matchCanonical('Do you require visa sponsorship?')?.key)
      .toBe('work_auth.sponsorship_required');
  });

  it('flags demographic questions as sensitive', () => {
    for (const label of ['Gender', 'Are you Hispanic/Latino?', 'Veteran Status', 'Disability Status']) {
      expect(matchCanonical(label)?.sensitive, label).toBe(true);
    }
  });

  it('flags employer-specific essays as per-company so they are never recycled', () => {
    expect(matchCanonical('Why do you want to join Figma?')?.perCompany).toBe(true);
    expect(matchCanonical('What excites you about this opportunity?')?.perCompany).toBe(true);
    // A plain factual question must not be marked per-company.
    expect(matchCanonical('What is your notice period?')?.perCompany).toBeFalsy();
  });

  it('returns nothing for a question it does not know, rather than a bad guess', () => {
    expect(matchCanonical('Describe your experience with Kubernetes operators')).toBeUndefined();
    expect(matchCanonical('Which of our product values resonates most with you?')).toBeUndefined();
  });
});

describe('label similarity', () => {
  const sim = (a: string, b: string) => cosine(vectorize(a), vectorize(b));

  it('scores near-duplicate phrasings high enough to reuse', () => {
    expect(
      sim(
        'How many years of professional experience do you have?',
        'How many years of professional experience do you have',
      ),
    ).toBeGreaterThan(0.95);
    expect(
      sim(
        'What are your salary expectations?',
        'What are your compensation expectations?',
      ),
    ).toBeGreaterThan(0.86);
  });

  it('scores unrelated questions low enough to refuse reuse', () => {
    expect(sim('What is your notice period?', 'What are your salary expectations?')).toBeLessThan(0.5);
    expect(sim('LinkedIn profile', 'GitHub profile')).toBeLessThan(0.86);
  });

  it('normalises away the noise that makes identical questions look different', () => {
    expect(normalizeLabel('Are you legally authorised to work?  *')).toBe(
      normalizeLabel('Are you legally authorized to work?'),
    );
    expect(normalizeLabel('E-mail (required)')).toBe(normalizeLabel('Email'));
  });
});

describe('experience fit', () => {
  it('heavily penalises years-of-experience mismatches', () => {
    const result = scoreExperienceFit(
      '[experience.years_total] Years of professional experience: 4',
      'We need a senior engineer with 8+ years of backend experience building distributed systems.',
    );

    expect(result).not.toBeNull();
    expect(result!.scoreDelta).toBeLessThan(-25);
    expect(result!.reason.toLowerCase()).toMatch(/8\+|8 years|4 years|experience/);
  });

  it('allows a close match to pass without a penalty', () => {
    const result = scoreExperienceFit(
      '[experience.years_total] Years of professional experience: 8',
      'We need a senior engineer with 8+ years of backend experience.',
    );

    expect(result?.scoreDelta ?? 0).toBeGreaterThanOrEqual(0);
  });
});

describe('option compatibility', () => {
  it('refuses to reuse a yes/no answer on an unrelated option set', () => {
    const yesNo = [{ label: 'Yes' }, { label: 'No' }];
    const seniority = [{ label: 'Junior' }, { label: 'Mid' }, { label: 'Senior' }];
    expect(optionsCompatible(yesNo, seniority)).toBe(false);
    expect(optionsCompatible(yesNo, [{ label: 'Yes' }, { label: 'No' }, { label: 'Unsure' }])).toBe(true);
  });

  it('lets stored free text be typed into anything', () => {
    expect(optionsCompatible(null, [{ label: 'Yes' }])).toBe(true);
    expect(optionsCompatible([{ label: 'Yes' }], undefined)).toBe(true);
  });
});

describe('mapping an answer onto a form control', () => {
  it('maps a boolean onto verbose real-world option labels', () => {
    const opts = [
      { label: 'Yes, I am authorized to work for any employer in the US' },
      { label: 'No, I will require sponsorship' },
    ];
    expect(matchOption('true', opts)?.option.label).toBe(opts[0]!.label);
    expect(matchOption('no', opts)?.option.label).toBe(opts[1]!.label);
  });

  it('returns nothing when a mapping would be a guess', () => {
    const opts = [{ label: 'Junior' }, { label: 'Mid-level' }, { label: 'Senior' }, { label: 'Staff' }];
    // "Experienced" fits several of these and none of them. Better to ask.
    const m = matchOption('Experienced', opts);
    expect(m === null || m.score < 0.7).toBe(true);
  });

  it('matches exactly when the answer is already an option', () => {
    const opts = [{ label: '1 month' }, { label: '3 months' }];
    expect(matchOption('1 month', opts)).toMatchObject({ score: 1 });
  });

  it('finds the decline-to-answer option that EEO questions default to', () => {
    expect(
      findDeclineOption([{ label: 'Male' }, { label: 'Female' }, { label: 'Decline To Self Identify' }])?.label,
    ).toBe('Decline To Self Identify');
    expect(
      findDeclineOption([{ label: 'Yes' }, { label: 'No' }, { label: 'I prefer not to say' }])?.label,
    ).toBe('I prefer not to say');
    expect(findDeclineOption([{ label: 'Yes' }, { label: 'No' }])).toBeNull();
  });
});
