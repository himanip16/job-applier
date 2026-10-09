/**
 * Bulk-triage the lead queue.
 *
 * Dry by default. `--apply` is what actually writes, and even then it only
 * moves rows to REJECTED with a category and a reason - nothing is deleted, so
 * a rule that turns out to be too broad is undone by setting the status back.
 *
 *   pnpm --filter @ja/server exec tsx src/scripts/cleanupLeads.ts
 *   pnpm --filter @ja/server exec tsx src/scripts/cleanupLeads.ts --apply
 */

import { prisma } from '../lib/db.js';
import { cleanupVerdict } from '../discovery/leadCleanup.js';
import { candidateConstraints } from '../discovery/hardRules.js';

const apply = process.argv.includes('--apply');
const showKept = process.argv.includes('--kept');

const profile = await prisma.profile.findFirst({
  where: { resumeText: { not: null } },
  include: { facts: { select: { key: true, value: true } } },
  orderBy: { updatedAt: 'desc' },
});
if (!profile) throw new Error('No profile with a resume to judge against.');

const { candidateYears } = candidateConstraints(profile);
console.log(
  `Profile: ${profile.fullName} - ${candidateYears ?? '?'} years, ${profile.city ?? '?'}, ${profile.country ?? '?'}`,
);

const leads = await prisma.jobLead.findMany({
  where: { profileId: profile.id, status: 'NEW' },
  select: {
    id: true,
    title: true,
    companyName: true,
    location: true,
    remote: true,
    descriptionText: true,
    score: true,
  },
});

interface Cut {
  id: string;
  category: string;
  reason: string;
  rule: string;
  title: string;
  companyName: string;
  location: string | null;
}

const cuts: Cut[] = [];
const kept: typeof leads = [];

for (const lead of leads) {
  const verdict = cleanupVerdict(lead, candidateYears);
  if (verdict) {
    cuts.push({
      id: lead.id,
      ...verdict,
      title: lead.title,
      companyName: lead.companyName,
      location: lead.location,
    });
  } else {
    kept.push(lead);
  }
}

// ---- report --------------------------------------------------------------
const byRule = new Map<string, Cut[]>();
for (const c of cuts) {
  const list = byRule.get(c.rule) ?? [];
  list.push(c);
  byRule.set(c.rule, list);
}

console.log(`${leads.length} in the queue -> cutting ${cuts.length}, keeping ${kept.length}`);
console.log('By rule:');
for (const [rule, list] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(5)}  ${rule}`);
  for (const ex of list.slice(0, 3)) {
    console.log(`         e.g. ${ex.title} - ${ex.companyName} (${ex.location ?? 'no location'})`);
  }
}

if (showKept) {
  console.log('Keeping (top 60 by score):');
  for (const k of kept.sort((a, b) => b.score - a.score).slice(0, 60)) {
    console.log(
      `  ${String(Math.round(k.score)).padStart(3)}  ${k.title} - ${k.companyName} (${k.location ?? 'no location'})`,
    );
  }
}

if (!apply) {
  console.log('Dry run. Nothing written. Re-run with --apply to commit.');
  await prisma.$disconnect();
  process.exit(0);
}

// ---- write ---------------------------------------------------------------
// One update per distinct (category, reason) rather than per lead: the reason
// text repeats heavily, and 3,500 individual round-trips is a minute of
// nothing for no benefit.
let written = 0;
const groups = new Map<string, { category: string; reason: string; ids: string[] }>();
for (const c of cuts) {
  const key = `${c.category} ${c.reason}`;
  const g = groups.get(key) ?? { category: c.category, reason: c.reason, ids: [] };
  g.ids.push(c.id);
  groups.set(key, g);
}
for (const g of groups.values()) {
  for (let i = 0; i < g.ids.length; i += 500) {
    const batch = g.ids.slice(i, i + 500);
    const r = await prisma.jobLead.updateMany({
      where: { id: { in: batch } },
      data: {
        status: 'REJECTED',
        rejectCategory: g.category,
        rejectReason: g.reason,
        decidedAt: new Date(),
      },
    });
    written += r.count;
  }
}
console.log(`Marked ${written} lead(s) REJECTED. ${kept.length} left in the queue.`);
await prisma.$disconnect();
