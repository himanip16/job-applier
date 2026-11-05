import { z } from 'zod';
import { generate, describeLlmError } from '../llm/client.js';
import type { DiscoveredJob } from './sources/index.js';

const FitSchema = z.object({
  score: z.number().describe('0-100. How well this job fits this candidate, all things considered.'),
  verdict: z.enum(['STRONG', 'WORTH_A_LOOK', 'STRETCH', 'MISMATCH']),
  forIt: z.array(z.string()).describe('Concrete reasons this is a good fit. Cite the posting.'),
  againstIt: z.array(z.string()).describe('Concrete reasons it is not. Include anything that contradicts their stated preferences.'),
  seniorityFit: z.enum(['BELOW', 'MATCH', 'ABOVE', 'UNCLEAR']),
  compensationFit: z.enum(['BELOW_CURRENT', 'BELOW_EXPECTED', 'MATCHES_EXPECTED', 'ABOVE_EXPECTED', 'UNCLEAR']).describe('How the compensation compares to current CTC and expectations.'),
  dealbreaker: z.string().describe('A single hard blocker if one exists (visa, location, clearance, compensation below current CTC), otherwise empty.'),
});

export type FitAssessment = z.infer<typeof FitSchema>;

const FIT_SYSTEM = `You triage job postings for one specific candidate. You are the filter that decides whether a real person spends twenty minutes applying.

Judge fit, not quality. A prestigious job that does not match this candidate is a MISMATCH.

Weigh, in this order:
1. Hard blockers. Location they cannot work in, visa sponsorship the posting rules out, clearance they do not hold, a seniority band far off theirs, compensation below their current CTC. Any of these makes it a MISMATCH regardless of how well the rest reads.
2. Compensation match. The posting must offer compensation at or above the candidate's current CTC. If the posting's compensation is below their current CTC, this is a hard blocker. If it's below their expected CTC but above current, it's a negative but not necessarily a blocker. Compensation above expected CTC is a strong positive.
3. Experience match. If the posting gives a minimum years of experience and the candidate is materially under it, that is a major negative. A 4-year candidate is not a strong match for an 8+ year requirement, even if the domain overlap is good. Do not hand-wave this away as "similar role" or "senior enough"; a real mismatch should drag the score down sharply and usually be called out in the reasons.
4. What they have explicitly rejected before. The rejection history is the strongest available signal about what they actually want, and it usually contradicts what a resume implies. Respect it.
5. Skill and domain overlap with their actual experience, not with adjacent things they could plausibly learn.
6. Seniority. Being two levels under the bar wastes their time; being three levels over it wastes it differently.

Be decisive and be specific. "Good technical match" is useless; "their four years on payment ledgers maps directly onto the settlement work in the third bullet" is what the candidate needs to see. Cite the posting in your reasons.

Do not inflate. Most postings a crawler finds are a poor fit, and a triage tool that calls everything a 75 is worthless.`;

export async function assessFit(args: {
  candidateContext: string;
  preferences: string;
  rejectionHistory: string;
  /** From candidateConstraints. Stated so the model stops estimating it from resume dates. */
  candidateYears?: number | null;
  job: Pick<DiscoveredJob, 'title' | 'companyName' | 'location' | 'descriptionText' | 'remote'>;
}): Promise<FitAssessment | null> {
  const years =
    args.candidateYears != null
      ? `\n\n<total_experience>\n${args.candidateYears} years of professional experience. This is the candidate's own figure: use it as given, do not re-estimate it from resume dates.\n</total_experience>`
      : '';
  try {
    return await generate({
      task: 'fitScoring',
      system: FIT_SYSTEM,
      prompt: `${args.candidateContext}${years}

<stated_preferences>
${args.preferences || 'None recorded.'}
</stated_preferences>

<what_they_have_rejected_before>
${args.rejectionHistory || 'No rejection history yet.'}
</what_they_have_rejected_before>

<posting>
title: ${args.job.title}
company: ${args.job.companyName}
location: ${args.job.location ?? 'not stated'}${args.job.remote ? ' (remote)' : ''}

${args.job.descriptionText.slice(0, 12000)}
</posting>

Assess the fit.`,
      schema: FitSchema,
      maxTokens: 3000,
    });
  } catch (err) {
    throw new Error(describeLlmError(err));
  }
}

/**
 * Batch version of assessFit that scores multiple jobs in a single LLM call.
 * This is more efficient than calling assessFit for each job individually.
 */
const BatchFitSchema = z.object({
  assessments: z.array(
    z.object({
      index: z.number().describe('Index of the job in the input array (0-based).'),
      score: z.number().describe('0-100. How well this job fits this candidate, all things considered.'),
      verdict: z.enum(['STRONG', 'WORTH_A_LOOK', 'STRETCH', 'MISMATCH']),
      forIt: z.array(z.string()).describe('Concrete reasons this is a good fit. Cite the posting.'),
      againstIt: z.array(z.string()).describe('Concrete reasons it is not. Include anything that contradicts their stated preferences.'),
      seniorityFit: z.enum(['BELOW', 'MATCH', 'ABOVE', 'UNCLEAR']),
      dealbreaker: z.string().describe('A single hard blocker if one exists (visa, location, clearance), otherwise empty.'),
    })
  )
});

export async function assessFitBatch(args: {
  candidateContext: string;
  preferences: string;
  rejectionHistory: string;
  jobs: Array<Pick<DiscoveredJob, 'title' | 'companyName' | 'location' | 'descriptionText' | 'remote'>>;
}): Promise<(FitAssessment | null)[]> {
  if (args.jobs.length === 0) return [];
  
  // For very small batches, use individual calls to avoid complexity
  if (args.jobs.length <= 3) {
    const results = await Promise.all(
      args.jobs.map(job => 
        assessFit({ ...args, job }).catch(() => null)
      )
    );
    return results;
  }

  try {
    const jobsText = args.jobs.map((job, idx) => 
      `<job_${idx}>
title: ${job.title}
company: ${job.companyName}
location: ${job.location ?? 'not stated'}${job.remote ? ' (remote)' : ''}

${job.descriptionText.slice(0, 8000)}
</job_${idx}>`
    ).join('\n\n');

    const result = await generate({
      task: 'fitScoring',
      system: FIT_SYSTEM + '\n\nYou are scoring multiple jobs at once. Return an assessment for each job with its index.',
      prompt: `${args.candidateContext}

<stated_preferences>
${args.preferences || 'None recorded.'}
</stated_preferences>

<what_they_have_rejected_before>
${args.rejectionHistory || 'No rejection history yet.'}
</what_they_have_rejected_before>

<postings>
${jobsText}
</postings>

Assess the fit for each job. Return an array of assessments, one for each job, with the index matching the job number.`,
      schema: BatchFitSchema,
      maxTokens: 8000,
    });

    if (!result) return args.jobs.map(() => null);

    // Sort assessments by index and return in order
    const sorted = [...result.assessments].sort((a, b) => a.index - b.index);
    const assessments = new Map(sorted.map(a => [a.index, a]));
    
    return args.jobs.map((_, idx) => {
      const assessment = assessments.get(idx);
      if (!assessment) return null;
      const { index, ...fit } = assessment;
      return fit as FitAssessment;
    });
  } catch (err) {
    // Fall back to individual calls if batch fails
    console.error('Batch scoring failed, falling back to individual calls:', err);
    return await Promise.all(
      args.jobs.map(job => 
        assessFit({ ...args, job }).catch(() => null)
      )
    );
  }
}
