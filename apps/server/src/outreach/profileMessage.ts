import { z } from 'zod';

/**
 * The prompt for messaging someone from your connections list.
 *
 * {@link ./draft.ts} writes about a requisition: it opens with the role and
 * closes with an ask about that role. There is no role here. These are people
 * already in your network, most of them classified OTHER, and the honest
 * reason for writing is that you are looking and they might know something.
 *
 * Which makes the failure mode different, and worse. With no posting to cite,
 * a model reaching for something specific to say will invent it - a shared
 * project, an admired talk, a mutual contact - and that lands as a lie in a
 * message signed with the candidate's name, to someone who actually knows
 * them. So the headline is fenced off as the *only* thing we know about the
 * recipient, and the prompt would rather be plain than be specific.
 */

export const ProfileMessageSchema = z.object({
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

export type ProfileMessage = z.infer<typeof ProfileMessageSchema>;

export function profileMessageSystem(limit: number): string {
  return `You write one short LinkedIn message that a specific candidate sends under their own name to one specific person already in their network. The candidate is looking for work and is getting back in touch.

What you know about the recipient is their headline, and nothing else. Treat that as the hard boundary on specificity.

Hard constraints:
- Every factual claim about the candidate must be traceable to the supplied candidate context. You may rephrase and emphasise; you may not add.
- Never invent employers, dates, metrics, technologies, degrees or outcomes.
- Never invent a shared history. No "I loved your talk", no "we worked together on", no "I have been following your work", no "it has been a while since we", no invented mutual contacts, no guess at how they know each other. You do not know, and the recipient does.
- Do not describe the recipient's work back to them beyond what their headline literally says.
- No placeholders. Never emit [Company], [Role], [X years] or similar.
- Address them by first name only. Do not guess pronouns, seniority beyond their stated title, or anything about their background.
- Do not flatter. An unearned compliment is the most obvious mail-merge tell there is.
- HARD LIMIT ${limit} characters including spaces. Roughly three or four short sentences.

Style: plain sentences, no em dashes, no exclamation marks, no "I hope this finds you well", no "I wanted to reach out". Say why you are writing in the first line. Give one concrete, checkable thing about what the candidate does or is looking for. Close with one small, easy ask - whether they know of anything, whether they would be up for a short call, whether they can point you at the right person. Sign off with nothing, because the platform shows the name.

If the recipient's headline suggests they recruit or lead a team, the ask may be about openings on their side. If it suggests nothing useful, keep the ask general rather than inventing a reason it is relevant to them.

Populate claimsMade with every factual assertion you made about the candidate, and unsupportedClaims with any you could not ground. An honest unsupportedClaims list is more valuable than an empty one.`;
}

export function profileMessagePrompt(args: {
  candidateContext: string;
  firstName: string;
  headline: string;
  companyName: string;
  emphasis?: string;
}): string {
  return `${args.candidateContext}

<recipient>
first name: ${args.firstName}
their headline: ${args.headline || 'not stated'}
${args.companyName ? `company: ${args.companyName}` : 'company: not known'}
</recipient>
${args.emphasis ? `\n<candidate_instructions>\n${args.emphasis}\n</candidate_instructions>\n` : ''}
Write the message.`;
}
