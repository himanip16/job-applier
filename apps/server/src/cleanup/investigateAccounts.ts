/**
 * Script to investigate profile and user email relationships.
 *
 * This helps identify orphaned profiles, mismatched emails, and other issues
 * that could cause "Email already in use by another account" errors.
 */

import { PrismaClient } from '../../../../generated/prisma/index.js';

const prisma = new PrismaClient();

export async function investigateAccounts() {
  console.log('=== ACCOUNT INVESTIGATION ===\n');

  // Get all users
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      createdAt: true,
      lastLoginAt: true,
      _count: {
        select: {
          sessions: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  console.log(`Found ${users.length} users`);
  users.forEach((user) => {
    console.log(`\nUser ID: ${user.id}`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Created: ${user.createdAt}`);
    console.log(`  Last Login: ${user.lastLoginAt || 'Never'}`);
    console.log(`  Active Sessions: ${user._count.sessions}`);
  });

  // Get all profiles
  const profiles = await prisma.profile.findMany({
    select: {
      id: true,
      email: true,
      fullName: true,
      userId: true,
      createdAt: true,
      updatedAt: true,
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

  console.log(`\n\nFound ${profiles.length} profiles`);
  profiles.forEach((profile) => {
    console.log(`\nProfile ID: ${profile.id}`);
    console.log(`  Email: ${profile.email}`);
    console.log(`  Name: ${profile.fullName}`);
    console.log(`  User ID: ${profile.userId || 'None (orphaned)'}`);
    console.log(`  Created: ${profile.createdAt}`);
    console.log(`  Updated: ${profile.updatedAt}`);
    console.log(`  Applications: ${profile._count.applications}`);
    console.log(`  Answers: ${profile._count.answers}`);
    console.log(`  Facts: ${profile._count.facts}`);
    console.log(`  Resumes: ${profile._count.resumes}`);
  });

  // Find orphaned profiles (no userId)
  const orphanedProfiles = profiles.filter((p) => !p.userId);
  console.log(`\n\n=== ORPHANED PROFILES (${orphanedProfiles.length}) ===`);
  orphanedProfiles.forEach((profile) => {
    console.log(`\nProfile ID: ${profile.id}`);
    console.log(`  Email: ${profile.email}`);
    console.log(`  Name: ${profile.fullName}`);
    console.log(`  Has Data: ${profile._count.applications + profile._count.answers + profile._count.facts + profile._count.resumes > 0 ? 'Yes' : 'No'}`);
  });

  // Find email mismatches between user and profile
  console.log(`\n\n=== EMAIL MISMATCHES ===`);
  let mismatches = 0;
  for (const user of users) {
    const profile = await prisma.profile.findUnique({
      where: { userId: user.id },
    });
    if (profile && profile.email !== user.email) {
      console.log(`\nUser ${user.id} (${user.email}) has profile with different email: ${profile.email}`);
      mismatches++;
    }
  }
  if (mismatches === 0) {
    console.log('No email mismatches found');
  }

  // Find profiles that share emails with different users
  console.log(`\n\n=== EMAIL CONFLICTS ===`);
  const profileEmails = profiles.filter((p) => p.userId).map((p) => ({ email: p.email, userId: p.userId, profileId: p.id }));
  const userEmails = users.map((u) => ({ email: u.email, userId: u.id }));

  let conflicts = 0;
  for (const profile of profileEmails) {
    const matchingUser = userEmails.find((u) => u.email === profile.email && u.userId !== profile.userId);
    if (matchingUser) {
      console.log(`\nProfile ${profile.profileId} (${profile.email}) belongs to user ${profile.userId} but email matches user ${matchingUser.userId}`);
      conflicts++;
    }
  }
  if (conflicts === 0) {
    console.log('No email conflicts found');
  }

  return {
    users,
    profiles,
    orphanedProfiles: orphanedProfiles.length,
    mismatches,
    conflicts,
  };
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  investigateAccounts()
    .then(() => {
      console.log('\nInvestigation complete');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Investigation failed:', error);
      process.exit(1);
    });
}
