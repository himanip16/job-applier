import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrate, searchPaged } from '../src/discovery/sources/careerSites/shared.js';
import { amazonSource } from '../src/discovery/sources/careerSites/amazon.js';
import { countryByCode } from '@ja/shared';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('partial source coverage', () => {
  it('reports query and paging limits while keeping the results that arrived', async () => {
    const warnings: string[] = [];
    const seen: string[] = [];
    const jobs = await searchPaged({ queries: ['a', 'b', 'c', 'd'], onWarning: (m) => warnings.push(m) }, 20,
      async (q, offset) => {
        seen.push(q);
        return { items: Array.from({ length: 20 }, (_, i) => `${q}-${offset + i}`), total: 100 };
      }, 0);
    expect(new Set(seen)).toEqual(new Set(['a', 'b', 'c']));
    expect(jobs).toHaveLength(180);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('3 of 4');
    expect(warnings.slice(1).every((m) => m.includes('60 results'))).toBe(true);
  });

  it('does not report partial coverage when a full final page reaches the total', async () => {
    const warning = vi.fn();
    await searchPaged({ onWarning: warning }, 20,
      async () => ({ items: Array.from({ length: 20 }, (_, i) => i), total: 60 }), 0);
    expect(warning).not.toHaveBeenCalled();
  });

  it('reports omitted details and failed pages without losing successful postings', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const work = hydrate(Array.from({ length: 35 }, (_, i) => i), async (i) => {
      if (i === 2) throw new Error('unavailable');
      return { title: 'Engineer', url: `https://example.com/${i}`, ats: 'test', companyName: 'Test', remote: false, descriptionText: 'Build services.' };
    }, { onWarning: (m) => warnings.push(m) });
    await vi.runAllTimersAsync();
    const jobs = await work;
    expect(jobs).toHaveLength(29);
    expect(warnings).toEqual([
      'Reading details for 30 of 35 discovered postings; coverage is partial.',
      '1 posting detail page(s) could not be read.',
    ]);
  });

  it('reads Amazon results in Node and sends the selected country to its backend', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ hits: 1, jobs: [{
      title: 'Software Development Engineer II', job_path: '/en/jobs/123/test',
      normalized_location: 'Bengaluru, India', posted_date: 'September 25, 2026',
      description: '<p>Build backend services.</p>', basic_qualifications: '<p>3 years of experience.</p>',
    }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await amazonSource.fetchJobs('', { queries: ['Software Engineer'], country: countryByCode('IN') });
    const url = new URL(String((fetcher.mock.calls[0] as unknown as [string])[0]));
    expect(url.searchParams.get('country')).toBe('IND');
    expect(url.searchParams.get('base_query')).toBe('Software Engineer');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Software Development Engineer II', companyName: 'Amazon', location: 'Bengaluru, India', url: 'https://www.amazon.jobs/en/jobs/123/test' });
    expect(jobs[0]?.descriptionText).toContain('3 years of experience.');
    expect(jobs[0]?.descriptionText).not.toContain('<p>');
  });
});
