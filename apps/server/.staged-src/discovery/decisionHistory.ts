import type { Prisma } from '../lib/db.js';

/** Older scoring runs stored automatic judgments as rejections. Do not learn from those. */
export const candidateRejections: Prisma.JobLeadWhereInput = {
  status: 'REJECTED',
  OR: [
    { rejectReason: null },
    { NOT: [
      { rejectReason: { startsWith: 'Auto-rejected:', mode: 'insensitive' } },
      { rejectReason: { startsWith: 'Auto-dismissed:', mode: 'insensitive' } },
    ] },
  ],
};
