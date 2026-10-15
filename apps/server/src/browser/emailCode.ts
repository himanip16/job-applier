import type { Page } from 'playwright';
import { detectBlockers } from './blockers.js';
import { settle } from './steps.js';
import {
  Inbox,
  companyHints,
  findCode,
  findVerifyLink,
  isVerificationEmail,
  relevance,
  type InboxMessage,
} from '../lib/inbox.js';

/**
 * "We sent a code to your email": fetch it from your Gmail and put it in.
 *
 * Only ever reads mail that arrived around the time the wall appeared and that
 * is from, or about, the company whose page this is (or an ATS mailer sending
 * for it). Anything ambiguous - no such email within the wait, two different
 * codes, a site that does not take the code - ends in `ok: false`, and the run
 * pauses for you exactly as it did before this existed. It never retries a
 * code the site rejected and never guesses.
 */

const WAIT_MS = 120_000;
const POLL_MS = 6_000;
/** For the first stretch, only mail sent after the wall could be the one. */
const FRESH_MS = 30_000;
/** Codes are usually sent just before the wall shows (on Register / Submit). */
const SENT_BEFORE_WALL_MS = 90_000;
/** After the fresh stretch, an email this old is still worth trying. */
const LOOSE_MS = 5 * 60_000;

/** Emails already used for a wall in this process, so a second wall never reuses one. */
const used = new Set<string>();

export interface EmailCodeResult {
  ok: boolean;
  detail: string;
}

export async function clearEmailVerification(
  page: Page,
  opts: { email: string; appPassword: string; company?: string | null; log: (line: string) => Promise<void> },
): Promise<EmailCodeResult> {
  const wallAt = Date.now();
  const hints = companyHints(page.url(), opts.company);
  const inbox = await Inbox.open(opts.email, opts.appPassword);
  const skip = new Set(used);
  let found: { msg: InboxMessage; code: string | null; link: string | null } | null = null;
  try {
    await opts.log(`Checking ${opts.email} for the verification email (up to ${WAIT_MS / 1000}s).`);
    while (!found && Date.now() - wallAt < WAIT_MS) {
      const fresh = Date.now() - wallAt < FRESH_MS;
      const cutoff = new Date(wallAt - (fresh ? SENT_BEFORE_WALL_MS : LOOSE_MS));
      const messages = (await inbox.since(new Date(wallAt - LOOSE_MS), skip))
        .filter((m) => !used.has(m.key) && m.receivedAt >= cutoff && isVerificationEmail(m))
        .map((m) => ({ msg: m, score: relevance(m, hints) }))
        .filter((m) => m.score > 0)
        // Most relevant first, then newest: a resent code supersedes the first.
        .sort((a, b) => b.score - a.score || b.msg.receivedAt.getTime() - a.msg.receivedAt.getTime());
      for (const { msg } of messages) {
        const code = findCode(msg);
        const link = code ? null : findVerifyLink(msg);
        if (code || link) {
          found = { msg, code, link };
          break;
        }
      }
      if (!found) await page.waitForTimeout(POLL_MS);
    }
  } finally {
    inbox.close();
  }

  if (!found) {
    return {
      ok: false,
      detail: `No verification email from ${hints[0] ?? 'this site'} reached ${opts.email} within ${WAIT_MS / 1000}s.`,
    };
  }
  used.add(found.msg.key);
  const source = `"${found.msg.subject}" from ${found.msg.from}`;

  if (found.code) {
    const typed = await typeCode(page, found.code);
    if (!typed.ok) return { ok: false, detail: `Found a code in ${source}, but ${typed.detail}` };
    await opts.log(`Entered the code from ${source}.`);
  } else {
    await opts.log(`Opening the verify link from ${source}.`);
    const tab = await page.context().newPage();
    try {
      await tab.goto(found.link!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await settle(tab);
    } finally {
      await tab.close().catch(() => {});
    }
    // The waiting page does not know the address was verified until it asks again.
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  await settle(page);
  await page.waitForTimeout(1500);
  const still = (await detectBlockers(page)).some((b) => b.kind === 'EMAIL_VERIFICATION');
  if (still) {
    return {
      ok: false,
      detail: found.code
        ? `The site did not accept code ${found.code} from ${source}.`
        : `Opened the verify link from ${source}, but the page still asks to verify.`,
    };
  }
  return { ok: true, detail: 'Email verified; carrying on.' };
}

/** Find the code box (or the row of one-digit boxes), fill it, and press Verify. */
async function typeCode(page: Page, code: string): Promise<EmailCodeResult> {
  const count = await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('[data-ja-otp]'))) el.removeAttribute('data-ja-otp');
    const shown = (el: HTMLElement) =>
      typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(
      (el) =>
        shown(el) &&
        !el.disabled &&
        !el.readOnly &&
        ['', 'text', 'number', 'tel', 'password'].includes(el.type.toLowerCase()),
    );
    const hint = (el: HTMLInputElement) =>
      [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete, el.labels?.[0]?.textContent]
        .filter(Boolean)
        .join(' ');
    const boxes = inputs.filter((el) => el.maxLength === 1);
    let chosen: HTMLInputElement[] = [];
    if (boxes.length >= 4 && boxes.length <= 8) chosen = boxes;
    else {
      const one =
        inputs.find((el) => el.autocomplete === 'one-time-code') ??
        inputs.find(
          (el) =>
            /otp|one.?time|passcode|verif\w*.?code|security.?code|\bcode\b|\bpin\b|token/i.test(hint(el)) &&
            !/zip|postal|country|area|promo|referral|coupon|discount/i.test(hint(el)),
        );
      if (one) chosen = [one];
    }
    chosen.forEach((el, i) => el.setAttribute('data-ja-otp', String(i)));
    return chosen.length;
  });

  if (!count) return { ok: false, detail: 'there is no code box on the page to type it into.' };
  if (count > 1 && count !== code.length) {
    return { ok: false, detail: `the page has ${count} code boxes and the code has ${code.length} characters.` };
  }
  if (count === 1) {
    await page.locator('[data-ja-otp="0"]').fill(code);
  } else {
    for (let i = 0; i < count; i++) await page.locator(`[data-ja-otp="${i}"]`).fill(code.charAt(i));
  }

  // Never "Submit application": the review gate decides that, not an email.
  const buttons = page
    .getByRole('button', { name: /^\s*(verify|confirm|continue|next|submit|validate|done)\b/i })
    .filter({ hasNotText: /application|apply/i });
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    if ((await b.isVisible().catch(() => false)) && (await b.isEnabled().catch(() => false))) {
      await b.click();
      break;
    }
  }
  // No button at all is fine: plenty of code boxes submit on the last digit.
  return { ok: true, detail: '' };
}
