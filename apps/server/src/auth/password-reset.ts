import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../lib/db.js';
import { hashPassword } from './passwords.js';

/** Password reset tokens expire after 1 hour. */
const RESET_TOKEN_HOURS = 1;

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a password reset token for a user.
 *
 * Returns the token string that should be sent to the user's email.
 * Only a hash of the token is stored in the database.
 */
export async function createPasswordResetToken(userId: string): Promise<string> {
  // Invalidate any existing tokens for this user
  await prisma.passwordReset.deleteMany({ where: { userId } });

  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_HOURS * 60 * 60 * 1000);

  await prisma.passwordReset.create({
    data: { tokenHash, userId, expiresAt },
  });

  return token;
}

/**
 * Check if a password reset token is valid without consuming it.
 *
 * Returns true if the token exists, is unused, and hasn't expired.
 * This is used to validate the token before expensive password hashing.
 */
export async function isPasswordResetTokenValid(token: string): Promise<boolean> {
  const tokenHash = hashResetToken(token);

  const reset = await prisma.passwordReset.findUnique({
    where: { tokenHash },
  });

  if (!reset) return false;
  if (reset.usedAt) return false;
  if (reset.expiresAt.getTime() <= Date.now()) return false;

  return true;
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

/**
 * Complete a password reset using a token.
 *
 * This function performs the entire password reset operation:
 * 1. Validates the token (lightweight check to prevent CPU exhaustion)
 * 2. Hashes the new password (expensive, only if token is valid)
 * 3. Reads the reset record to get userId
 * 4. Atomically consumes the reset token in a transaction
 * 5. Updates the user's password
 * 6. Invalidates all sessions for the user
 *
 * Password hashing is done before the transaction but after token validation
 * to prevent CPU exhaustion attacks with invalid tokens.
 * The transaction's updateMany() remains the final security guarantee.
 *
 * Returns true if the password reset was successful, false if the token was invalid.
 */
export async function completePasswordReset(token: string, newPassword: string): Promise<boolean> {
  const tokenHash = hashResetToken(token);

  // Lightweight token validation before expensive password hashing
  const isValid = await isPasswordResetTokenValid(token);
  if (!isValid) {
    return false;
  }

  // Hash password - expensive operation, only done if token is valid
  const passwordHash = await hashPassword(newPassword);

  try {
    await prisma.$transaction(async (tx) => {
      // Read the reset record to get userId (not used as security guarantee)
      const reset = await tx.passwordReset.findUnique({
        where: { tokenHash },
      });

      if (!reset || reset.usedAt !== null || reset.expiresAt.getTime() <= Date.now()) {
        throw new Error('Invalid or expired token');
      }

      // Atomically consume the token - this is the security guarantee
      const result = await tx.passwordReset.updateMany({
        where: {
          tokenHash,
          usedAt: null,
          expiresAt: {
            gt: new Date(),
          },
        },
        data: {
          usedAt: new Date(),
        },
      });

      if (result.count !== 1) {
        throw new Error('Invalid or expired token');
      }

      // Update the user's password
      await tx.user.update({
        where: { id: reset.userId },
        data: { passwordHash },
      });

      // Invalidate all sessions for this user
      await tx.session.deleteMany({
        where: { userId: reset.userId },
      });
    });

    return true;
  } catch {
    // Transaction failed - likely invalid token
    return false;
  }
}
