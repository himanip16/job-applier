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
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

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
 * What is wrong with a password, in a sentence, or null if nothing is.
 *
 * Length is the only rule. Composition rules ("one capital, one symbol")
 * measurably push people toward Password1! and away from a long passphrase,
 * which is the opposite of what they are for.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters. A short phrase is ideal.';
  if (password.length > 200) return 'That is longer than 200 characters.';
  return null;
}
