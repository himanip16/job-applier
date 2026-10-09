import { Prisma, prisma } from '../lib/db.js';

/**
 * Where each connection's conversation stands.
 *
 * This is the question the list is really answering - "who am I holding up,
 * and who is holding me up" - and it cannot be computed on the page. The list
 * is paginated, so the status has to be known to the database before LIMIT
 * runs, or a section would be whatever happened to land in the current
 * twenty-five rows.
 *
 * The signal that decides a turn is `linkedin_messages.isFromMe` on the most
 * recent message. NOTE: nothing populates that table yet - there is no message
 * sync - so until one exists, YOUR_TURN is unreachable and a sent message
 * stays in AWAITING_REPLY however long ago they answered. The classification
 * is written against the real column rather than around it, so landing the
 * sync is all that is needed to light it up.
 */
export const STATUSES = ['YOUR_TURN', 'DRAFTED', 'AWAITING_REPLY', 'NOT_CONTACTED', 'CLOSED'] as const;
export type ConversationStatus = (typeof STATUSES)[number];

export type ConnectionSort = 'status' | 'name' | 'role' | 'company';

export interface ConnectionRow {
  id: string;
  fullName: string;
  headline: string | null;
  companyName: string;
  profileUrl: string;
  role: string;
  location: string | null;
  status: ConversationStatus;
  /** The most recent message either way, when messages have been synced. */
  lastMessageAt: Date | null;
  conversationClosedAt: Date | null;
}

/**
 * Sections in the order the work wants doing.
 *
 * Someone waiting on a reply from you comes before a draft you have not sent,
 * which comes before a thread where the ball is in their court. Closed is last
 * because it is the only one that is finished.
 */
const RANK = Prisma.sql`CASE "status"
  WHEN 'YOUR_TURN' THEN 0
  WHEN 'DRAFTED' THEN 1
  WHEN 'AWAITING_REPLY' THEN 2
  WHEN 'NOT_CONTACTED' THEN 3
  ELSE 4 END`;

const ORDER: Record<ConnectionSort, Prisma.Sql> = {
  status: Prisma.sql`${RANK}, "fullName" ASC, "id" ASC`,
  name: Prisma.sql`"fullName" ASC, "id" ASC`,
  // ContactRole is declared TALENT, ENGINEERING, OTHER and Postgres sorts an
  // enum in declaration order, so this is priority order for free.
  role: Prisma.sql`"role" ASC, "fullName" ASC, "id" ASC`,
  company: Prisma.sql`"companyName" ASC, "fullName" ASC, "id" ASC`,
};

/**
 * Every connection on the profile, labelled with where its conversation stands.
 *
 * Kept as one CTE that both the page query and the totals query select from,
 * so a count can never disagree with the rows underneath it.
 */
function classified(profileId: string): Prisma.Sql {
  return Prisma.sql`
    WITH ranked AS (
      SELECT
        conv."contactId",
        m."isFromMe",
        m."sentAt",
        ROW_NUMBER() OVER (
          PARTITION BY conv."contactId" ORDER BY m."sentAt" DESC, m."id" DESC
        ) AS rn
      FROM "linkedin_messages" m
      JOIN "linkedin_conversations" conv ON conv."id" = m."conversationId"
      WHERE conv."profileId" = ${profileId}
    ),
    last_message AS (
      SELECT "contactId", "isFromMe", "sentAt" FROM ranked WHERE rn = 1
    ),
    items AS (
      SELECT
        "contactId",
        bool_or("status"::text = 'SENT') AS has_sent,
        bool_or("status"::text IN ('DRAFT', 'APPROVED', 'SENDING')) AS has_open_draft
      FROM "outreach_items"
      WHERE "profileId" = ${profileId}
      GROUP BY "contactId"
    ),
    classified AS (
      SELECT
        c."id", c."fullName", c."headline", c."companyName", c."profileUrl",
        c."role"::text AS "role", c."location", c."conversationClosedAt",
        lm."sentAt" AS "lastMessageAt",
        CASE
          -- Your own decision outranks everything the history implies.
          WHEN c."conversationClosedAt" IS NOT NULL THEN 'CLOSED'
          -- They spoke last, so the reply is owed by you.
          WHEN lm."isFromMe" IS FALSE THEN 'YOUR_TURN'
          -- Something is written and waiting on your approval.
          WHEN i.has_open_draft THEN 'DRAFTED'
          WHEN lm."isFromMe" IS TRUE OR i.has_sent THEN 'AWAITING_REPLY'
          ELSE 'NOT_CONTACTED'
        END AS "status"
      FROM "contacts" c
      LEFT JOIN last_message lm ON lm."contactId" = c."id"
      LEFT JOIN items i ON i."contactId" = c."id"
      WHERE c."profileId" = ${profileId} AND c."isConnection" = TRUE
    )`;
}

export async function statusTotals(profileId: string): Promise<Record<ConversationStatus, number>> {
  const rows = await prisma.$queryRaw<{ status: ConversationStatus; count: bigint }[]>`
    ${classified(profileId)}
    SELECT "status", COUNT(*) AS count FROM classified GROUP BY "status"`;

  const totals = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<ConversationStatus, number>;
  for (const row of rows) totals[row.status] = Number(row.count);
  return totals;
}

export async function readConnectionPage(args: {
  profileId: string;
  sort: ConnectionSort;
  skip: number;
  take: number;
}): Promise<ConnectionRow[]> {
  return prisma.$queryRaw<ConnectionRow[]>`
    ${classified(args.profileId)}
    SELECT
      "id", "fullName", "headline", "companyName", "profileUrl", "role",
      "location", "status", "lastMessageAt", "conversationClosedAt"
    FROM classified
    ORDER BY ${ORDER[args.sort]}
    LIMIT ${args.take} OFFSET ${args.skip}`;
}
