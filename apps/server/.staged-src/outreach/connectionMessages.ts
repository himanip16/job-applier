import type { OutreachChannel } from '../lib/db.js';
import { prisma } from '../lib/db.js';
import { generate } from '../llm/client.js';
import { renderCandidateContext } from '../llm/candidateContext.js';
import { CHAR_LIMITS } from '../linkedin/send.js';
import { firstNameOf } from './draft.js';
import { ProfileMessageSchema, profileMessageSystem, profileMessagePrompt } from './profileMessage.js';

/**
 * Writing to people you already know, from the connections list.
 *
 * The existing cold path ({@link ./generate.ts}) is organised around a job
 * posting: it needs a lead before it can say anything, and it only knows how
 * to address recruiters and engineering leaders. That is the right shape for
 * "apply to this req", and the wrong shape for "message these forty people I
 * am connected to", where most of them have role OTHER and no lead matches
 * their company at all.
 *
 * So this module composes from the *person* instead of the posting, and offers
 * the two things someone actually wants at that moment: let the model write
 * one message per person from their headline, or take a message they already
 * wrote and address it to each of them.
 *
 * Both land as DRAFT. Nothing here sends: the queue's approve step and
 * {@link ../linkedin/send.ts} remain the only way a message leaves.
 */

export type MessageMode = 'AI' | 'TEMPLATE';

/** Placeholders a hand-written message may use. Anything else is left alone. */
const PLACEHOLDERS = ['firstName', 'fullName', 'company', 'headline'] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];

export interface MessageContact {
  id: string;
  fullName: string;
  headline: string | null;
  companyName: string;
  role: string;
  isConnection: boolean;
}

export interface ComposeInput {
  profileId: string;
  contactIds: string[];
  mode: MessageMode;
  /** The user's own words. Required when mode is TEMPLATE, ignored otherwise. */
  body?: string;
  /** Optional steer for the model: "mention the payments work". */
  emphasis?: string;
}

export interface ComposeResult {
  created: { id: string; contactId: string; fullName: string; charLimit: number; overLimit: boolean }[];
  errors: { contactId: string; fullName: string; error: string }[];
}

/**
 * Fill a hand-written message in for one person.
 *
 * Unknown braces are left untouched: someone writing about `{ useState }` did
 * not mean to address anybody, and silently blanking it would be worse than
 * leaving it visible in the draft they are about to read.
 */
export function personalise(template: string, contact: MessageContact): string {
  const values: Record<Placeholder, string> = {
    firstName: firstNameOf(contact.fullName),
    fullName: contact.fullName,
    // "Unknown" is the sync's placeholder for a company it could not read, and
    // is rejected before we get here rather than pasted into the message.
    company: contact.companyName,
    headline: contact.headline ?? '',
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    (PLACEHOLDERS as readonly string[]).includes(key) ? values[key as Placeholder] : whole,
  );
}

/** Which placeholders a template cannot fill for this person. */
export function unfillable(template: string, contact: MessageContact): Placeholder[] {
  const used = new Set(Array.from(template.matchAll(/\{(\w+)\}/g), (m) => m[1]));
  return PLACEHOLDERS.filter((key) => {
    if (!used.has(key)) return false;
    if (key === 'company') return !contact.companyName || contact.companyName === 'Unknown';
    if (key === 'headline') return !contact.headline;
    return !contact.fullName;
  });
}

const channelFor = (contact: MessageContact): OutreachChannel =>
  contact.isConnection ? 'DIRECT_MESSAGE' : 'CONNECTION_NOTE';

/**
 * Draft one message per selected connection.
 *
 * One contact's failure is reported against that contact and the rest carry
 * on. A rate-limited model on person nine should not throw away the eight
 * drafts already written, and the caller shows the per-person reasons.
 */
export async function composeConnectionMessages(input: ComposeInput): Promise<ComposeResult> {
  const result: ComposeResult = { created: [], errors: [] };
  const contactIds = [...new Set(input.contactIds)];

  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds }, profileId: input.profileId },
    select: { id: true, fullName: true, headline: true, companyName: true, role: true, isConnection: true },
  });
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));

  const template = (input.body ?? '').trim();
  if (input.mode === 'TEMPLATE' && !template) {
    throw new Error('Write the message you want to send before creating drafts.');
  }

  // Loaded once for the whole batch: the candidate does not change between
  // recipients, and re-reading the resume per contact is the slow part.
  const candidateContext = input.mode === 'AI' ? await loadCandidateContext(input.profileId) : '';

  for (const contactId of contactIds) {
    const contact = byId.get(contactId);
    if (!contact) {
      result.errors.push({ contactId, fullName: contactId, error: 'This connection is not on your profile.' });
      continue;
    }
    try {
      const channel = channelFor(contact);
      const charLimit = CHAR_LIMITS[channel];
      const body = input.mode === 'TEMPLATE'
        ? templateBodyFor(template, contact)
        : await aiBodyFor({ candidateContext, contact, charLimit, emphasis: input.emphasis });

      const item = await upsertDraft({ profileId: input.profileId, contact, channel, charLimit, body });
      result.created.push({
        id: item.id, contactId, fullName: contact.fullName, charLimit,
        overLimit: body.length > charLimit,
      });
    } catch (err) {
      result.errors.push({
        contactId,
        fullName: contact.fullName,
        error: err instanceof Error ? err.message : 'Could not draft this message.',
      });
    }
  }
  return result;
}

function templateBodyFor(template: string, contact: MessageContact): string {
  const missing = unfillable(template, contact);
  if (missing.length) {
    throw new Error(
      `Your message uses ${missing.map((key) => `{${key}}`).join(' and ')}, and LinkedIn never gave us ` +
        `${missing.length > 1 ? 'those details' : 'that detail'} for this person. Remove the placeholder or drop them from the selection.`,
    );
  }
  return personalise(template, contact).trim();
}

async function aiBodyFor(args: {
  candidateContext: string;
  contact: MessageContact;
  charLimit: number;
  emphasis?: string;
}): Promise<string> {
  const limit = Math.min(450, args.charLimit);
  const draft = await generate({
    task: 'outreach',
    system: profileMessageSystem(limit),
    prompt: profileMessagePrompt({
      candidateContext: args.candidateContext,
      firstName: firstNameOf(args.contact.fullName),
      headline: args.contact.headline ?? '',
      companyName: args.contact.companyName === 'Unknown' ? '' : args.contact.companyName,
      emphasis: args.emphasis,
    }),
    schema: ProfileMessageSchema,
    maxTokens: 1500,
  });
  if (!draft) throw new Error('The model declined to write this one. Write it yourself, or drop them from the selection.');
  return draft.body.trim();
}

async function loadCandidateContext(profileId: string): Promise<string> {
  const profile = await prisma.profile.findUniqueOrThrow({
    where: { id: profileId },
    include: { facts: true },
  });
  return renderCandidateContext(profile, profile.resumeText);
}

/**
 * One COLD draft per contact, keyed by the empty jobUrl these messages carry.
 *
 * Redrafting is normal - you try the model, dislike it, and paste your own
 * words instead - so an untouched DRAFT is overwritten. Anything past DRAFT is
 * not: silently rewriting a message you already approved, or one already sent,
 * would lose the record of what actually went out.
 */
async function upsertDraft(args: {
  profileId: string;
  contact: MessageContact;
  channel: OutreachChannel;
  charLimit: number;
  body: string;
}): Promise<{ id: string }> {
  const where = { profileId: args.profileId, contactId: args.contact.id, type: 'COLD' as const, jobUrl: '' };
  const existing = await prisma.outreachItem.findFirst({ where });

  if (!existing) {
    return prisma.outreachItem.create({
      data: {
        ...where,
        companyName: args.contact.companyName,
        jobTitle: '',
        channel: args.channel,
        draftBody: args.body,
        charLimit: args.charLimit,
        status: 'DRAFT',
      },
      select: { id: true },
    });
  }

  if (existing.status !== 'DRAFT') {
    throw new Error(
      existing.status === 'SENT'
        ? 'You have already sent this person a message. Open the Replies tab to follow up instead.'
        : `A message for this person is already ${existing.status.toLowerCase()}. Deal with it in the First contact tab first.`,
    );
  }

  return prisma.outreachItem.update({
    where: { id: existing.id },
    data: {
      channel: args.channel,
      draftBody: args.body,
      charLimit: args.charLimit,
      companyName: args.contact.companyName,
      // The old edit belonged to the old draft. Keeping it would show the
      // editor a body nobody asked for over a draft they just regenerated.
      finalBody: null,
      editedAt: null,
    },
    select: { id: true },
  });
}
