import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing, with no new dependency.
 *
 * scrypt ships in Node and is a memory-hard KDF, which is the property that
 * matters: an attacker with the table cannot trade memory for parallelism the
 * way they can against a plain hash. bcrypt or argon2 would be equally fine
 * and would each add a native build step to a project that has to install
 * cleanly on a Render box.
 *
 * The parameters live in the stored string rather than in this file, so the
 * cost can be raised later without invalidating every existing password.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
/** scrypt needs roughly 128 * N * r bytes; the default cap is below that. */
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Constant-time by construction.
 *
 * A malformed or unrecognised stored hash returns false rather than throwing:
 * a login route that can 500 on a bad row tells an attacker which accounts
 * have one.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  
  // Validate scrypt parameters to prevent CPU/memory exhaustion attacks
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < 1024 ||
    n > 1_048_576 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 8 ||
    (n & (n - 1)) !== 0  // N must be a power of 2
  ) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;

  try {
    const key = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * Password validation result with detailed feedback.
 */
export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
  requirements: {
    minLength: number;
    maxLength: number;
    requiresUppercase: boolean;
    requiresLowercase: boolean;
    requiresNumber: boolean;
    requiresSpecial: boolean;
  };
}

/**
 * What is wrong with a password, in a sentence, or null if nothing is.
 *
 * Password must be at least 10 characters and include uppercase, lowercase,
 * number, and special character for enhanced security.
 */
export function passwordProblem(password: string): string | null {
  const result = validatePassword(password);
  if (result.valid) return null;
  return result.errors.join(' ');
}

/**
 * Detailed password validation that returns all issues at once.
 *
 * This provides more comprehensive feedback for better user experience.
 */
export function validatePassword(password: string): PasswordValidationResult {
  const errors: string[] = [];
  
  if (password.length < 10) {
    errors.push('Use at least 10 characters');
  }
  if (password.length > 200) {
    errors.push('That is longer than 200 characters');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Include at least one uppercase letter (A-Z)');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Include at least one lowercase letter (a-z)');
  }
  if (!/\d/.test(password)) {
    errors.push('Include at least one number (0-9)');
  }
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Include at least one special character (!@#$%^&*(),.?":{}|<>)');
  }

  return {
    valid: errors.length === 0,
    errors,
    requirements: {
      minLength: 10,
      maxLength: 200,
      requiresUppercase: true,
      requiresLowercase: true,
      requiresNumber: true,
      requiresSpecial: true,
    },
  };
}
