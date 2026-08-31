import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/db.js';

/** Password reset tokens expire after 1 hour. */
const RESET_TOKEN_HOURS = 1;

/**
 * Generate a password reset token for a user.
 *
 * Returns the token string that should be sent to the user's email.
 * The token is stored in the database with an expiration time.
 */
export async function createPasswordResetToken(userId: string): Promise<string> {
  // Invalidate any existing tokens for this user
  await prisma.passwordReset.deleteMany({ where: { userId } });

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000);

  await prisma.passwordReset.create({
    data: { token, userId, expiresAt },
  });

  return token;
}

/**
 * Validate a password reset token.
 *
 * Returns the user ID if the token is valid and unused, null otherwise.
 */
export async function validatePasswordResetToken(token: string): Promise<string | null> {
  const reset = await prisma.passwordReset.findUnique({
    where: { token },
    include: { user: true },
  });

  if (!reset) return null;
  if (reset.usedAt) return null;
  if (reset.expiresAt.getTime() < Date.now()) return null;

  return reset.userId;
}

/**
 * Mark a password reset token as used.
 */
export async function markPasswordResetTokenUsed(token: string): Promise<void> {
  await prisma.passwordReset.update({
    where: { token },
    data: { usedAt: new Date() },
  });
}

/**
 * Clean up expired and used password reset tokens.
 *
 * This can be called periodically to keep the table clean.
 */
export async function cleanupExpiredPasswordResetTokens(): Promise<void> {
  await prisma.passwordReset.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { usedAt: { not: null } },
      ],
    },
  });
}
