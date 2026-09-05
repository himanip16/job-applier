import { prisma } from '../lib/db.js';
import type { OutreachChannel, ContactRole } from '../lib/db.js';
import { draftOutreach, firstNameOf } from './draft.js';
import { CHAR_LIMITS } from '../linkedin/send.js';
import { crawlAll } from '../discovery/crawler.js';

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
  // Load contact and profile, enforcing ownership in the lookup itself.
  const [contact, profile] = await Promise.all([
    prisma.contact.findFirstOrThrow({
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
      where: { id: input.jobLeadId, profileId: input.profileId },
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

  // Build candidate context
  const candidateContext = buildCandidateContext({ ...profile, email: profile.user?.email });

  // Determine channel based on connection degree
  const channel: OutreachChannel = contact.isConnection ? 'DIRECT_MESSAGE' : 'CONNECTION_NOTE';
  const charLimit = CHAR_LIMITS[channel];

  // Generate message draft
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
    overLimit: draft.overLimit,
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
  if (profile.email) parts.push(`Email: ${profile.email}`);

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

  const contacts = await prisma.contact.findMany({
    where: { profileId: input.profileId, id: { in: input.contactIds } },
    select: { id: true, companyKey: true },
  });
  const companies = await prisma.company.findMany({ where: { enabled: true } });
  const companyByKey = new Map(
    companies.map(company => [company.name.toLowerCase().replace(/[^a-z0-9]/g, ''), company]),
  );
  const refreshed = new Set<string>();

  for (const contactId of input.contactIds) {
    try {
      const contact = contacts.find(candidate => candidate.id === contactId);
      let jobLeadId = input.jobLeadId;
      if (!jobLeadId && contact) {
        let lead = await bestLeadForCompany(input.profileId, contact.companyKey);
        const company = companyByKey.get(contact.companyKey);
        if (!lead && company && !refreshed.has(company.id)) {
          refreshed.add(company.id);
          await crawlAll(input.profileId, { onlyCompanyId: company.id, deepScoreTop: 5 });
          lead = await bestLeadForCompany(input.profileId, contact.companyKey);
        }
        jobLeadId = lead?.id;
      }
      const result = await generateColdOutreach({
        profileId: input.profileId,
        contactId,
        jobLeadId,
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

async function bestLeadForCompany(profileId: string, companyKey: string) {
  const leads = await prisma.jobLead.findMany({
    where: { profileId, status: { in: ['NEW', 'SHORTLISTED'] } },
    orderBy: [{ score: 'desc' }, { discoveredAt: 'desc' }],
  });
  return leads.find(
    lead => lead.companyName.toLowerCase().replace(/[^a-z0-9]/g, '') === companyKey,
  );
}
