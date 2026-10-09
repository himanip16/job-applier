import { describe, expect, it } from 'vitest';
import { jobPostingsFromLd } from '../src/discovery/sources/jobPostingLd.js';

/**
 * Reading the schema.org JobPosting a careers page embeds. Pure parsing: no
 * browser, no network, no database.
 */

const block = (value: unknown) => JSON.stringify(value);

describe('schema.org JobPosting', () => {
  it('reads location, date and company from the block', () => {
    const [p] = jobPostingsFromLd([
      block({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Backend Engineer',
        datePosted: '2026-09-01',
        description: '<p>Build &amp; run APIs</p>',
        hiringOrganization: { '@type': 'Organization', name: 'Acme' },
        jobLocation: [
          { '@type': 'Place', address: { addressLocality: 'Bengaluru', addressRegion: 'KA', addressCountry: { name: 'India' } } },
          { '@type': 'Place', address: { addressLocality: 'Pune', addressCountry: 'IN' } },
        ],
      }),
    ]);
    expect(p).toMatchObject({
      title: 'Backend Engineer',
      location: 'Bengaluru, KA, India; Pune, IN',
      remote: false,
      companyName: 'Acme',
      descriptionText: 'Build & run APIs',
    });
    expect(p!.postedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('finds postings inside an @graph and reads remote-with-country', () => {
    const postings = jobPostingsFromLd([
      block({
        '@graph': [
          { '@type': 'WebPage' },
          { '@type': ['JobPosting'], title: 'SRE', url: '/jobs/2', jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { '@type': 'Country', name: 'India' } },
        ],
      }),
    ]);
    expect(postings).toEqual([expect.objectContaining({ title: 'SRE', url: '/jobs/2', remote: true, location: 'Remote - India' })]);
  });

  it('leaves out what the block does not say, and survives a broken block', () => {
    const postings = jobPostingsFromLd(['{not json', block({ '@type': 'Organization' }), block({ '@type': 'JobPosting', title: 'Engineer' })]);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.location).toBeUndefined();
    expect(postings[0]!.postedAt).toBeUndefined();
  });
});
