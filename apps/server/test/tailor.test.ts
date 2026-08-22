import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The resume tailor's one promise is that it will not put something on your
 * resume that you cannot back up. These tests attack that promise directly:
 * the model is stubbed to misbehave in exactly the way a real model
 * occasionally does, and the code must catch it.
 */

const parseMock = vi.fn();
vi.mock('../src/llm/client.js', () => ({
  llm: () => ({ messages: { parse: (...a: unknown[]) => parseMock(...a) } }),
  MODEL: 'test-model',
  describeLlmError: (e: unknown) => (e as Error).message,
}));

const { tailorResume } = await import('../src/resume/tailor.js');
const { normaliseForAts, renderResume } = await import('../src/resume/render.js');

const RESUME = `Himani Patel
himani@example.com | San Francisco, CA

SUMMARY
Backend engineer with nine years building payment systems.

EXPERIENCE
Stripe - Staff Engineer - Jan 2019 to Present
- Built distributed payment ledgers in Go backed by Postgres.
- Led a team of six engineers across two time zones.
- Deployed services to AWS ECS with Terraform.

SKILLS
Go, TypeScript, Postgres, Kafka, AWS, Terraform`;

const JD = `We are hiring a Staff Backend Engineer. You will work in Go on high-throughput
payment infrastructure, run services on Kubernetes, and mentor a team.
Required: Go, distributed systems, Kubernetes, PCI DSS compliance experience.`;

const args = {
  candidateContext: `<candidate_profile>\nname: Himani Patel\n</candidate_profile>`,
  resumeText: RESUME,
  jobTitle: 'Staff Backend Engineer',
  companyName: 'Northwind',
  jobDescription: JD,
};

beforeEach(() => parseMock.mockReset());

describe('resume tailoring', () => {
  it('adds only grounded keywords and records the evidence for each', async () => {
    parseMock
      .mockResolvedValueOnce({
        parsed_output: {
          covered: [
            { keyword: 'Go', where: 'Built distributed payment ledgers in Go' },
            { keyword: 'distributed systems', where: 'distributed payment ledgers' },
          ],
          grounded: [
            {
              keyword: 'mentoring',
              evidence: 'Led a team of six engineers across two time zones.',
              sourceField: 'resume',
              suggestion: 'Led and mentored a team of six engineers across two time zones.',
            },
          ],
          unsupported: [
            {
              keyword: 'Kubernetes',
              importance: 'REQUIRED' as const,
              note: 'They run ECS, not Kubernetes. Adjacent, not the same.',
            },
            {
              keyword: 'PCI DSS',
              importance: 'REQUIRED' as const,
              note: 'Payments experience, but no compliance work stated.',
            },
          ],
          atsIssues: [],
        },
      })
      .mockResolvedValueOnce({
        parsed_output: {
          text: RESUME.replace(
            'Led a team of six engineers across two time zones.',
            'Led and mentored a team of six engineers across two time zones.',
          ),
          changes: [
            {
              keyword: 'mentoring',
              before: 'Led a team of six engineers across two time zones.',
              after: 'Led and mentored a team of six engineers across two time zones.',
            },
          ],
        },
      });

    const result = await tailorResume(args);

    expect(result.insertions).toHaveLength(1);
    expect(result.insertions[0]).toMatchObject({
      keyword: 'mentoring',
      evidence: 'Led a team of six engineers across two time zones.',
      sourceField: 'resume',
    });

    // The unsupported ones are reported, and are genuinely absent from the text.
    expect(result.unsupported.map((u) => u.keyword)).toEqual(['Kubernetes', 'PCI DSS']);
    expect(result.text).not.toMatch(/kubernetes/i);
    expect(result.text).not.toMatch(/PCI/i);
    expect(result.violations).toEqual([]);

    // Dates, employer and title are untouched.
    expect(result.text).toContain('Stripe - Staff Engineer - Jan 2019 to Present');
  });

  it('catches the model sneaking in an unsupported keyword, rather than shipping it', async () => {
    parseMock
      .mockResolvedValueOnce({
        parsed_output: {
          covered: [{ keyword: 'Go', where: 'in Go' }],
          grounded: [
            {
              keyword: 'containers',
              evidence: 'Deployed services to AWS ECS with Terraform.',
              sourceField: 'resume',
              suggestion: 'Deployed containerised services to AWS ECS with Terraform.',
            },
          ],
          unsupported: [
            { keyword: 'Kubernetes', importance: 'REQUIRED' as const, note: 'Not in the material.' },
          ],
          atsIssues: [],
        },
      })
      // The rewrite helpfully "upgrades" ECS to Kubernetes. This is the exact
      // failure the whole design exists to prevent.
      .mockResolvedValueOnce({
        parsed_output: {
          text: RESUME.replace(
            'Deployed services to AWS ECS with Terraform.',
            'Deployed containerised services to Kubernetes and AWS ECS with Terraform.',
          ),
          changes: [{ keyword: 'containers', before: '', after: 'Deployed containerised services…' }],
        },
      });

    const result = await tailorResume(args);

    expect(result.violations).toContain('Kubernetes');
    // And it is not quietly counted as a legitimate insertion.
    expect(result.insertions.map((i) => i.keyword)).not.toContain('Kubernetes');
  });

  it('does not flag a keyword that was already in the original resume', async () => {
    parseMock
      .mockResolvedValueOnce({
        parsed_output: {
          covered: [],
          grounded: [],
          // Deliberately mislabelled: Terraform IS in the original. The check
          // must compare against the original, not assume the analysis is right.
          unsupported: [
            { keyword: 'Terraform', importance: 'PREFERRED' as const, note: 'mislabelled' },
          ],
          atsIssues: ['Skills listed as a comma run-on; one per line parses better.'],
        },
      })
      .mockResolvedValueOnce({ parsed_output: { text: RESUME, changes: [] } });

    const result = await tailorResume(args);
    expect(result.violations).toEqual([]);
  });

  it('skips the rewrite entirely when there is nothing to add and nothing to fix', async () => {
    parseMock.mockResolvedValueOnce({
      parsed_output: { covered: [{ keyword: 'Go', where: 'in Go' }], grounded: [], unsupported: [], atsIssues: [] },
    });

    const result = await tailorResume(args);
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(result.text).toBe(RESUME);
    expect(result.coverage).toBe(100);
  });

  it('reports coverage as covered-plus-added over everything the job asked for', async () => {
    parseMock
      .mockResolvedValueOnce({
        parsed_output: {
          covered: [{ keyword: 'Go', where: 'in Go' }, { keyword: 'Postgres', where: 'Postgres' }],
          grounded: [
            { keyword: 'mentoring', evidence: 'Led a team of six', sourceField: 'resume', suggestion: 'mentored' },
          ],
          unsupported: [{ keyword: 'Kubernetes', importance: 'REQUIRED' as const, note: 'no' }],
          atsIssues: [],
        },
      })
      .mockResolvedValueOnce({
        parsed_output: { text: `${RESUME}\n- Mentoring engineers.`, changes: [] },
      });

    const result = await tailorResume(args);
    // 2 covered + 1 added out of 4 total keywords.
    expect(Math.round(result.coverage)).toBe(75);
  });
});

describe('ATS-safe rendering', () => {
  it('strips the characters that break resume parsers', () => {
    const messy = 'SKILLS\n• Go\t• Rust\n“smart quotes” and an em—dash';
    const clean = normaliseForAts(messy);
    expect(clean).not.toMatch(/[•\t“”—]/);
    expect(clean).toContain('- Go');
    expect(clean).toContain('"smart quotes"');
    expect(clean).toContain('em-dash');
  });

  it('writes a real .docx and a plain .txt', async () => {
    const out = await renderResume(RESUME, { profileName: 'Himani Patel', slug: 'northwind-staff' });

    const txt = await readFile(out.txtAbsolute, 'utf8');
    expect(txt).toContain('EXPERIENCE');
    expect(txt).toContain('Himani Patel');

    const docx = await readFile(out.docxAbsolute);
    // A .docx is a zip; "PK" is the local file header magic.
    expect(docx.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(docx.length).toBeGreaterThan(2000);
    expect(out.docxPath).toMatch(/^resumes\/tailored\//);
  });
});
