import { prisma } from '../lib/db.js';
import type { ContactRole } from '../lib/db.js';

export interface ColdOutreachTarget {
  id: string;
  fullName: string;
  headline: string | null;
  companyName: string;
  profileUrl: string;
  role: ContactRole;
  degree: string | null;
  hasConversation: false;
  jobLeadId: string | null;
  jobTitle: string | null;
  jobUrl: string | null;
}

/** People we have neither messaged on LinkedIn nor already drafted outreach for. */
export async function findColdOutreachTargets(profileId: string): Promise<ColdOutreachTarget[]> {
  const contacts = await prisma.contact.findMany({
    where: {
      profileId,
      isConnection: true,
      role: { in: ['TALENT', 'ENGINEERING'] },
      conversations: { none: { messages: { some: { isFromMe: true } } } },
      outreachItems: { none: { status: { in: ['DRAFT', 'APPROVED', 'SENDING', 'SENT'] } } },
    },
    select: {
      id: true,
      fullName: true,
      headline: true,
      companyName: true,
      companyKey: true,
      profileUrl: true,
      role: true,
      degree: true,
    },
    orderBy: [{ discoveredAt: 'asc' }, { id: 'asc' }],
  });

  const leads = await prisma.jobLead.findMany({
    where: { profileId, status: { in: ['NEW', 'SHORTLISTED'] } },
    select: { id: true, title: true, url: true, companyName: true, score: true },
    orderBy: [{ score: 'desc' }, { discoveredAt: 'desc' }],
  });
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

  return contacts.map(({ companyKey, ...contact }) => {
    const lead = leads.find(candidate => key(candidate.companyName) === companyKey);
    return {
      ...contact,
      hasConversation: false as const,
      jobLeadId: lead?.id ?? null,
      jobTitle: lead?.title ?? null,
      jobUrl: lead?.url ?? null,
    };
  });
}

export async function countColdTargetsByRole(profileId: string) {
  const targets = await findColdOutreachTargets(profileId);
  const TALENT = targets.filter(target => target.role === 'TALENT').length;
  const ENGINEERING = targets.filter(target => target.role === 'ENGINEERING').length;
  return { TALENT, ENGINEERING, total: targets.length };
}
