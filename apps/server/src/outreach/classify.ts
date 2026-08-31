import { prisma } from '../lib/db.js';
import type { ContactRole } from '../lib/db.js';

/**
 * Find contacts eligible for cold outreach.
 *
 * Cold outreach criteria:
 * - isConnection = true (synced from LinkedIn, 1st-degree connections only)
 * - No LinkedIn conversation exists (never messaged)
 * - Role is TALENT or ENGINEERING (not OTHER)
 * - Ordered by discovery date (oldest first)
 *
 * IMPORTANT: Conversation detection uses the Contact relation (contactId),
 * not URL matching. This ensures consistency since both Contact and
 * LinkedInConversation use canonicalized profile URLs.
 *
 * NOTE: Since we filter for isConnection = true, all results are 1st-degree
 * connections by definition. Degree ordering is removed as it would be
 * meaningless (all values would be '1st').
 */
export async function findColdOutreachTargets(profileId: string): Promise<{
  id: string;
  fullName: string;
  headline: string | null;
  companyName: string;
  profileUrl: string;
  role: ContactRole;
  degree: string | null;
  hasConversation: boolean;
}[]> {
  const contacts = await prisma.contact.findMany({
    where: {
      profileId,
      isConnection: true,
      role: { in: ['TALENT', 'ENGINEERING'] },
      conversations: {
        none: {}, // No existing conversation
      },
    },
    select: {
      id: true,
      fullName: true,
      headline: true,
      companyName: true,
      profileUrl: true,
      role: true,
      degree: true,
    },
    orderBy: [
      { discoveredAt: 'asc' }, // Oldest first
    ],
  });

  // Add hasConversation: false since we filtered for no conversations
  return contacts.map(contact => ({
    ...contact,
    hasConversation: false,
  }));
}

/**
 * Count cold outreach targets by role.
 */
export async function countColdTargetsByRole(profileId: string): Promise<{
  TALENT: number;
  ENGINEERING: number;
  total: number;
}> {
  const [talent, engineering] = await Promise.all([
    prisma.contact.count({
      where: {
        profileId,
        isConnection: true,
        role: 'TALENT',
        conversations: { none: {} },
      },
    }),
    prisma.contact.count({
      where: {
        profileId,
        isConnection: true,
        role: 'ENGINEERING',
        conversations: { none: {} },
      },
    }),
  ]);

  return {
    TALENT: talent,
    ENGINEERING: engineering,
    total: talent + engineering,
  };
}
