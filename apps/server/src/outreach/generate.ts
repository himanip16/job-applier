import { prisma } from '../lib/db.js';
import type { OutreachChannel, ContactRole } from '../lib/db.js';
import { draftOutreach, firstNameOf } from './draft.js';
import { CHAR_LIMITS } from '../linkedin/send.js';

/**
 * Generate a cold outreach item.
 */
export async function generateColdOutreach(input: {
  profileId: string;
  contactId: string;
  jobLeadId?: string;
}): Promise<{
  id: string;
  draftBody: string;
  charLimit: number;
  overLimit: boolean;
}> {
  // Load contact and profile - ensure contact belongs to the profile
  const [contact, profile] = await Promise.all([
    prisma.contact.findUniqueOrThrow({
      where: { id: input.contactId, profileId: input.profileId },
    }),
    prisma.profile.findUniqueOrThrow({
      where: { id: input.profileId },
      include: {
        facts: true,
        user: true,
      },
    }),
  ]);

  // Load job lead if provided
  let jobTitle = '';
  let jobUrl = '';
  let companyName = contact.companyName;
  let jobDescription = '';

  if (input.jobLeadId) {
    const lead = await prisma.jobLead.findFirst({
      where: { 
        id: input.jobLeadId,
        profileId: input.profileId,
      },
      include: {
        company: true,
      },
    });
    if (lead) {
      jobTitle = lead.title;
      jobUrl = lead.url;
      companyName = lead.companyName;
      jobDescription = lead.descriptionText ?? '';
    }
  }

  // Validate company name - avoid empty strings in AI drafts
  if (!companyName || companyName.trim() === '') {
    throw new Error('Company name is required for outreach generation');
  }

  // Build candidate context
  const candidateContext = buildCandidateContext({
    fullName: profile.fullName,
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.user?.email,
    summary: profile.summary,
    resumeText: profile.resumeText,
    facts: profile.facts.map(f => ({ key: f.key, label: f.label, value: f.value })),
  });

  // Determine channel based on connection degree
  // Since findColdOutreachTargets only returns isConnection=true (1st-degree),
  // we default to DIRECT_MESSAGE. If contact is not a connection, use CONNECTION_NOTE.
  const channel: OutreachChannel = contact.isConnection ? 'DIRECT_MESSAGE' : 'CONNECTION_NOTE';
  const charLimit = CHAR_LIMITS[channel];

  // Check for existing DRAFT or APPROVED outreach for this contact
  const existing = await prisma.outreachItem.findFirst({
    where: {
      profileId: input.profileId,
      contactId: input.contactId,
      status: { in: ['DRAFT', 'APPROVED'] },
    },
  });

  if (existing) {
    throw new Error(`Outreach already exists for this contact (ID: ${existing.id}). Use the existing draft or skip it first.`);
  }

  // Generate message draft
  // Unknown roles use the referral message. Excluding them made a large part
  // of a connection sync silently ineligible for outreach.
  const contactRole: Exclude<ContactRole, 'OTHER'> =
    contact.role === 'TALENT' ? 'TALENT' : 'ENGINEERING';
  const draft = await draftOutreach({
    candidateContext,
    contactFirstName: firstNameOf(contact.fullName),
    contactHeadline: contact.headline ?? '',
    contactRole,
    companyName,
    jobTitle,
    jobUrl,
    jobDescription,
    channel,
  });

  // Create OutreachItem
  const item = await prisma.outreachItem.create({
    data: {
      profileId: input.profileId,
      contactId: input.contactId,
      type: 'COLD',
      leadId: input.jobLeadId,
      jobTitle,
      jobUrl,
      companyName,
      channel,
      draftBody: draft.body,
      charLimit,
      status: 'DRAFT',
    },
  });

  return {
    id: item.id,
    draftBody: draft.body,
    charLimit,
    overLimit: draft.body.length > charLimit,
  };
}

/**
 * Build candidate context for the LLM.
 */
function buildCandidateContext(profile: {
  fullName: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  summary?: string | null;
  resumeText?: string | null;
  facts: Array<{ key: string; label: string; value: string }>;
}): string {
  const parts: string[] = [];

  parts.push(`Name: ${profile.fullName}`);
  if (profile.email) {
    parts.push(`Email: ${profile.email}`);
  }

  if (profile.summary) {
    parts.push(`Summary: ${profile.summary}`);
  }

  if (profile.facts.length > 0) {
    parts.push('Facts:');
    for (const fact of profile.facts) {
      parts.push(`  ${fact.label}: ${fact.value}`);
    }
  }

  if (profile.resumeText) {
    parts.push(`Resume (first 2000 chars):\n${profile.resumeText.slice(0, 2000)}`);
  }

  return parts.join('\n\n');
}

/**
 * Batch generate cold outreach for multiple contacts.
 */
export async function generateColdOutreachBatch(input: {
  profileId: string;
  contactIds: string[];
  jobLeadId?: string;
}): Promise<{
  created: Array<{ id: string; contactId: string }>;
  errors: Array<{ contactId: string; error: string }>;
}> {
  const created: Array<{ id: string; contactId: string }> = [];
  const errors: Array<{ contactId: string; error: string }> = [];

  for (const contactId of input.contactIds) {
    try {
      const result = await generateColdOutreach({
        profileId: input.profileId,
        contactId,
        jobLeadId: input.jobLeadId,
      });
      created.push({ id: result.id, contactId });
    } catch (err) {
      errors.push({
        contactId,
        error: (err as Error).message,
      });
    }
  }

  return { created, errors };
}
