/**
 * Script to delete a specific user account and associated data.
 *
 * Usage: node --import tsx/esm src/cleanup/deleteAccount.ts <email>
 */

import { PrismaClient } from '../../../../generated/prisma/index.js';

const prisma = new PrismaClient();

export async function deleteAccount(email: string) {
  console.log(`=== DELETING ACCOUNT: ${email} ===\n`);

  // Find the user
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      profile: {
        include: {
          _count: {
            select: {
              applications: true,
              answers: true,
              facts: true,
              resumes: true,
            },
          },
        },
      },
      sessions: true,
      passwordResets: true,
    },
  });

  if (!user) {
    console.log(`User with email ${email} not found`);
    return { deleted: false, reason: 'User not found' };
  }

  console.log(`Found user: ${user.id}`);
  console.log(`Email: ${user.email}`);
  console.log(`Created: ${user.createdAt}`);
  console.log(`Last Login: ${user.lastLoginAt || 'Never'}`);
  console.log(`Has Profile: ${user.profile ? 'Yes' : 'No'}`);

  if (user.profile) {
    console.log(`\nProfile: ${user.profile.id}`);
    console.log(`  Name: ${user.profile.fullName}`);
    console.log(`  Applications: ${user.profile._count.applications}`);
    console.log(`  Answers: ${user.profile._count.answers}`);
    console.log(`  Facts: ${user.profile._count.facts}`);
    console.log(`  Resumes: ${user.profile._count.resumes}`);
  }

  console.log(`\nSessions: ${user.sessions.length}`);
  console.log(`Password Resets: ${user.passwordResets.length}`);

  // This will cascade delete:
  // - profile (and all its applications, answers, facts, resumes, etc.)
  // - sessions
  // - passwordResets
  console.log(`\nDeleting user and all associated data...`);

  await prisma.user.delete({
    where: { id: user.id },
  });

  console.log(`Account ${email} deleted successfully`);
  return { deleted: true, userId: user.id };
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node --import tsx/esm src/cleanup/deleteAccount.ts <email>');
    process.exit(1);
  }

  deleteAccount(email)
    .then(() => {
      console.log('\nDeletion complete');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Deletion failed:', error);
      process.exit(1);
    });
}
