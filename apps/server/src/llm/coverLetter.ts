import { z } from 'zod';
import { generate } from './client.js';

const CoverLetterSchema = z.object({
  body: z.string().describe('The cover letter body. No date, no letterhead, no placeholder brackets.'),
  claimsMade: z
    .array(z.string())
    .describe('Every factual claim about the candidate made in the letter, one per item.'),
  unsupportedClaims: z
    .array(z.string())
    .describe('Any claim you were unable to ground in the candidate context. Should normally be empty.'),
});

export type GeneratedCoverLetter = z.infer<typeof CoverLetterSchema>;

const SYSTEM = `You write cover letters that a specific candidate submits under their own name.

Hard constraints:
- Every factual claim about the candidate must be traceable to the supplied profile, facts or resume. You may rephrase and emphasise; you may not add.
- Never invent employers, dates, metrics, technologies, degrees or outcomes. If the resume says "improved performance", do not write "improved performance by 40%".
- No placeholders. Never emit [Company], [X years] or similar. If you lack a fact, write around it.
- Do not claim enthusiasm for specifics of the company you were not told about. Ground interest in the job description text you were given.
- British/American spelling: match the job description.

Style: 200-320 words, three or four short paragraphs, plain confident prose. No "I am writing to apply for". No bullet lists. No em dashes. Open with the specific reason this candidate fits this role, not with pleasantries.

Populate claimsMade with every factual assertion you made about the candidate, and unsupportedClaims with any you could not ground. Being honest in unsupportedClaims is more valuable than an empty list.`;

export interface CoverLetterInput {
  candidateContext: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  /** Optional extra steer from the user, e.g. "emphasise the payments work". */
  emphasis?: string;
  /** Some forms cap the field. */
  maxWords?: number;
}

export async function generateCoverLetter(input: CoverLetterInput): Promise<GeneratedCoverLetter> {
  const wordCap = input.maxWords ? `\nHard limit: ${input.maxWords} words.` : '';
  const parsed = await generate({
    task: 'coverLetter',
    system: SYSTEM,
    prompt: `${input.candidateContext}

<job>
company: ${input.companyName}
title: ${input.jobTitle}
description:
${input.jobDescription.slice(0, 15000)}
</job>
${input.emphasis ? `\n<candidate_instructions>\n${input.emphasis}\n</candidate_instructions>\n` : ''}
Write the cover letter.${wordCap}`,
    schema: CoverLetterSchema,
    maxTokens: 8000,
  });

  if (!parsed) throw new Error('Cover letter generation returned no parseable output.');
  return parsed;
}

const EssaySchema = z.object({
  answer: z.string(),
  groundedIn: z.array(z.string()).describe('Facts from the candidate context this answer relies on.'),
});

/**
 * Short free-text answers that are specific to one employer — "why do you want
 * to work here", "what interests you about this role". These are generated per
 * application and deliberately never cached into the answer bank.
 */
export async function generateEssayAnswer(args: {
  candidateContext: string;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  question: string;
  /** Character budget the form allows, if known. */
  maxChars?: number;
}): Promise<string> {
  const cap = args.maxChars ?? 900;
  const parsed = await generate({
    task: 'essay',
    system: `${SYSTEM}

You are answering one short application question, not writing a full letter. Answer the question directly in ${Math.max(60, Math.floor(cap / 8))} words or fewer. No greeting, no sign-off.`,
    prompt: `${args.candidateContext}

<job>
company: ${args.companyName}
title: ${args.jobTitle}
description:
${args.jobDescription.slice(0, 12000)}
</job>

<question>${args.question}</question>`,
    schema: EssaySchema,
    maxTokens: 4000,
  });
  const answer = parsed?.answer ?? '';
  return answer.length > cap ? `${answer.slice(0, cap - 1).trimEnd()}…` : answer;
}
