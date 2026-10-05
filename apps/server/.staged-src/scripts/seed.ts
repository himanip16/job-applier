/**
 * Create a starter profile and a set of facts covering the questions that show
 * up on almost every application. Edit the values, or edit them later in the UI.
 *
 *   pnpm --filter @ja/server seed
 */
import { prisma } from '../lib/db.js';

const FACTS = [
  { key: 'work_auth.authorized', label: 'Legally authorized to work in the country of the role', value: 'Yes', kind: 'BOOLEAN' as const },
  { key: 'work_auth.sponsorship_required', label: 'Requires visa sponsorship now or in future', value: 'No', kind: 'BOOLEAN' as const },
  { key: 'experience.years_total', label: 'Years of professional experience', value: '5', kind: 'NUMBER' as const },
  { key: 'compensation.expectation', label: 'Salary expectation', value: 'Open to discussion, targeting market rate', kind: 'TEXT' as const },
  { key: 'availability.notice_period', label: 'Notice period', value: '1 month', kind: 'TEXT' as const },
  { key: 'availability.start_date', label: 'Earliest start date', value: 'Four weeks from offer', kind: 'TEXT' as const },
  { key: 'logistics.relocate', label: 'Willing to relocate', value: 'No', kind: 'BOOLEAN' as const },
  { key: 'legal.age_18', label: 'At least 18 years old', value: 'Yes', kind: 'BOOLEAN' as const },
  { key: 'legal.non_compete', label: 'Subject to a non-compete', value: 'No', kind: 'BOOLEAN' as const },
  { key: 'history.source', label: 'How did you hear about this role', value: 'Company careers page', kind: 'TEXT' as const },
];

const existing = await prisma.profile.findFirst();
if (existing) {
  process.stdout.write(`Profile already exists for ${existing.email}. Nothing seeded.\n`);
  process.exit(0);
}

const profile = await prisma.profile.create({
  data: {
    email: process.env.SEED_EMAIL ?? 'you@example.com',
    fullName: process.env.SEED_NAME ?? 'Your Name',
    firstName: (process.env.SEED_NAME ?? 'Your Name').split(' ')[0]!,
    lastName: (process.env.SEED_NAME ?? 'Your Name').split(' ').slice(1).join(' ') || 'Name',
    city: 'London',
    country: 'United Kingdom',
    countryCode: 'GB',
    summary: 'Edit this in the UI: a two-line summary of what you do and what you are looking for.',
    facts: { create: FACTS },
  },
  include: { facts: true },
});

process.stdout.write(
  `Seeded profile ${profile.email} with ${profile.facts.length} facts.\n` +
    'Open the UI to correct them, then upload your resume.\n',
);
await prisma.$disconnect();
