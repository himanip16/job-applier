import { z } from 'zod';
import type { ContactRole, OutreachChannel } from '../lib/db.js';
import { generate } from '../llm/client.js';
import { CHAR_LIMITS } from '../linkedin/send.js';

/**
 * Writing the message.
 *
 * Same rule as the cover letter: every factual claim about the candidate has
 * to be traceable to the profile, the facts or the resume. The difference is
 * the audience. A cover letter is read by someone whose job is to read it; a
 * cold LinkedIn note is read by someone with forty unread invitations, in a
 * 300-character preview, on a phone. Length is the constraint that shapes
 * everything else here.
 *
 * The two roles get genuinely different messages rather than one template with
 * the salutation swapped. A recruiter can move an application forward and
 * wants to know you match the requisition. An engineering manager cannot
 * usually do anything with a resume and does not want one — what they can
 * answer is a real question about the work. Asking a recruiter about the
 * architecture, or asking a manager to pass your CV to HR, both read as a
 * mail-merge, which is exactly the impression that gets an account reported.
 */

const DraftSchema = z.object({
  body: z
    .string()
    .describe('The message body. No subject line, no placeholder brackets, no signature block.'),
  claimsMade: z
    .array(z.string())
    .describe('Every factual claim about the candidate made in the message, one per item.'),
  unsupportedClaims: z
    .array(z.string())
    .describe('Any claim you could not ground in the candidate context. Should normally be empty.'),
});

export type OutreachDraft = z.infer<typeof DraftSchema> & {
  /** True when the model could not get under the channel's cap. */
  overLimit: boolean;
};

const SHARED = `You write short LinkedIn messages that one specific candidate sends under their own name, to one specific person, about one specific job opening.

Hard constraints:
- Every factual claim about the candidate must be traceable to the supplied profile, facts or resume. You may rephrase and emphasise; you may not add.
- Never invent employers, dates, metrics, technologies, degrees or outcomes.
- No placeholders. Never emit [Company], [Role], [X years] or similar.
- Never claim a personal connection that was not supplied: no "I loved your talk", no "we met at", no "I've been following your work", no invented mutual contacts.
- Address the person by first name only. Do not guess at pronouns, seniority beyond their stated title, or anything about their background.
- Do not flatter. "Your team is doing incredible work" with nothing behind it is the single most obvious mail-merge tell.

Style: plain sentences, no em dashes, no exclamation marks, no "I hope this finds you well", no "I wanted to reach out". Open with why you are writing. One concrete, checkable reason this candidate fits. One clear ask. Sign off with nothing — the platform shows your name.

Populate claimsMade with every factual assertion you made about the candidate, and unsupportedClaims with any you could not ground. An honest unsupportedClaims list is more valuable than an empty one.`;

const BY_ROLE: Record<Exclude<ContactRole, 'OTHER'>, string> = {
  TALENT: `This recipient is a recruiter or talent-acquisition person. They can actually move an application forward, so the ask is process: whether the role is still open, whether they are the right person for it, or that they take a look at the application.

Lead with the requisition — name the exact role and say in one clause why the candidate matches it. Recruiters screen against a requirements list, so the fit sentence should use the terms the posting itself uses, where the candidate's own material supports them.`,

  ENGINEERING: `This recipient is an engineering manager or engineering leader. They usually cannot process an application and do not want a resume in their inbox. What they can do is tell you whether the team is a fit, and they respond to specific technical interest.

So: no "please forward my CV". Ask one real question about the work — the problem the team owns, how something in the posting is actually built, what the first six months look like. Ground the question in the job description you were given, not in invented knowledge about the company. Mention the candidate's relevant experience in one clause, as context for the question rather than as a pitch.`,
};

export interface DraftInput {
  candidateContext: string;
  contactFirstName: string;
  contactHeadline: string;
  contactRole: Exclude<ContactRole, 'OTHER'>;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
  jobDescription: string;
  channel: OutreachChannel;
  /** Optional steer from the user when re-drafting: "mention the payments work". */
  emphasis?: string;
}

/**
 * The character cap is stated in the prompt and checked afterwards.
 *
 * A 300-character connection note is the hard case: models overshoot it
 * routinely, and truncating server-side would send half a sentence under
 * someone's name. So one retry states the actual overshoot, and if that still
 * fails the draft comes back flagged rather than trimmed — the editor shows it
 * red and refuses to send until a human has cut it themselves.
 */
export async function draftOutreach(input: DraftInput): Promise<OutreachDraft> {
  const limit = CHAR_LIMITS[input.channel];
  const channelNote =
    input.channel === 'CONNECTION_NOTE'
      ? `This is a LinkedIn connection request note. HARD LIMIT ${limit} characters including spaces — LinkedIn will not accept one character more. That is about three short sentences. Be ruthless.`
      : `This is a LinkedIn direct message to an existing connection. Keep it under ${Math.min(900, limit)} characters; short messages get replies.`;

  const prompt = (feedback?: string) => `${input.candidateContext}

<recipient>
first name: ${input.contactFirstName}
their headline: ${input.contactHeadline}
company: ${input.companyName}
</recipient>

<job>
title: ${input.jobTitle}
url: ${input.jobUrl}
description:
${input.jobDescription.slice(0, 8000)}
</job>
${input.emphasis ? `\n<candidate_instructions>\n${input.emphasis}\n</candidate_instructions>\n` : ''}${
    feedback ? `\n<revision_required>\n${feedback}\n</revision_required>\n` : ''
  }
Write the message.`;

  const system = `${SHARED}\n\n${BY_ROLE[input.contactRole]}\n\n${channelNote}`;

  let parsed = await generate({
    task: 'outreach',
    system,
    prompt: prompt(),
    schema: DraftSchema,
    maxTokens: 2000,
  });
  if (!parsed) throw new Error('Outreach drafting returned no parseable output.');

  if (parsed.body.trim().length > limit) {
    const retry = await generate({
      task: 'outreach',
      system,
      prompt: prompt(
        `Your previous attempt was ${parsed.body.trim().length} characters, and the hard limit is ${limit}. ` +
          'Cut it down. Remove the least specific sentence first; keep the concrete fit detail and the ask.',
      ),
      schema: DraftSchema,
      maxTokens: 2000,
    });
    if (retry && retry.body.trim().length <= limit) parsed = retry;
  }

  const body = parsed.body.trim();
  return { ...parsed, body, overLimit: body.length > limit };
}

/** First name only, for the salutation. Falls back to the whole name. */
export function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}
