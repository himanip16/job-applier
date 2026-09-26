/**
 * Script to find and resolve duplicate email issues in profiles.
 *
 * This script identifies profiles with duplicate emails and helps resolve them
 * by removing orphaned profiles or merging them.
 */

import { PrismaClient } from '../../../../generated/prisma/index.js';

const prisma = new PrismaClient();

export async function findDuplicateEmails() {
  console.log('Finding profiles with duplicate emails...');

  // Find all emails that appear more than once
  const duplicateEmails = await prisma.profile.groupBy({
    by: ['email'],
    having: {
      email: {
        _count: {
          gt: 1,
        },
      },
    },
  });

  console.log(`Found ${duplicateEmails.length} emails with duplicates`);

  if (duplicateEmails.length === 0) {
    console.log('No duplicate emails found');
    return [];
  }

  // Get all profiles with these emails
  const profiles = await prisma.profile.findMany({
    where: {
      email: {
        in: duplicateEmails.map((d) => d.email),
      },
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
        },
      },
      _count: {
        select: {
          applications: true,
          answers: true,
          facts: true,
          resumes: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  // Group by email
  const grouped = profiles.reduce((acc, profile) => {
    const email = profile.email;
    if (!acc[email]) {
      acc[email] = [];
    }
    acc[email]!.push(profile);
    return acc;
  }, {} as Record<string, typeof profiles>);

  return grouped;
}

export async function resolveDuplicateEmails() {
  const grouped = await findDuplicateEmails();

  if (Object.keys(grouped).length === 0) {
    console.log('No duplicates to resolve');
    return { resolved: 0 };
  }

  let resolved = 0;

  for (const [email, profiles] of Object.entries(grouped)) {
    console.log(`\n--- Email: ${email} ---`);
    console.log(`Found ${profiles.length} profiles`);

    // Strategy: Keep the profile with a userId, delete orphaned ones
    const withUser = profiles.filter((p) => p.userId);
    const orphaned = profiles.filter((p) => !p.userId);

    console.log(`Profiles with user: ${withUser.length}`);
    console.log(`Orphaned profiles: ${orphaned.length}`);

    if (orphaned.length > 0) {
      console.log(`Deleting ${orphaned.length} orphaned profiles for email ${email}`);
      for (const profile of orphaned) {
        console.log(`  Deleting profile ${profile.id} (${profile.fullName})`);
        await prisma.profile.delete({
          where: { id: profile.id },
        });
        resolved++;
      }
    }

    // If multiple profiles have userId, keep the oldest one
    if (withUser.length > 1) {
      console.log(`Multiple profiles have userId for email ${email}, keeping oldest`);
      const toKeep = withUser[0];
      const toDelete = withUser.slice(1);

      for (const profile of toDelete) {
        console.log(`  Deleting profile ${profile.id} (${profile.fullName})`);
        await prisma.profile.delete({
          where: { id: profile.id },
        });
        resolved++;
      }
    }
  }

  console.log(`\nResolved ${resolved} duplicate email issues`);
  return { resolved };
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const grouped = await findDuplicateEmails();

  console.log('\n=== DUPLICATE EMAIL REPORT ===');
  for (const [email, profiles] of Object.entries(grouped)) {
    console.log(`\nEmail: ${email}`);
    profiles.forEach((profile) => {
      console.log(`  - ID: ${profile.id}`);
      console.log(`    Name: ${profile.fullName}`);
      console.log(`    User ID: ${profile.userId || 'None (orphaned)'}`);
      console.log(`    Created: ${profile.createdAt}`);
      console.log(`    Applications: ${profile._count.applications}`);
      console.log(`    Answers: ${profile._count.answers}`);
      console.log(`    Facts: ${profile._count.facts}`);
      console.log(`    Resumes: ${profile._count.resumes}`);
    });
  }

  console.log('\n=== RESOLVING DUPLICATES ===');
  const result = await resolveDuplicateEmails();
  console.log('Resolution complete');

  process.exit(0);
}
