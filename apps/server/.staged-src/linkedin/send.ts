import type { Page } from 'playwright';
import type { OutreachChannel } from '../lib/db.js';
import { config } from '../lib/config.js';
import { openLinkedIn } from './session.js';

/**
 * The only code in this feature that clicks Send.
 *
 * Everything upstream — finding jobs, finding people, writing drafts — is
 * reversible and private. This is not, so it is deliberately the smallest,
 * dullest module here: it takes a body a human has already approved, types it,
 * and confirms afterwards that LinkedIn's own UI agrees something was sent. It
 * never composes text, never picks a recipient, and never runs from a
 * background job or a timer.
 *
 * `verifySent` matters more than it looks. A click that lands on a disabled
 * button, or on a dialog that reopened with a validation error, leaves the
 * page looking almost exactly like success — and a message recorded as SENT
 * that never went is worse than a visible failure, because the whole point of
 * the queue is knowing who has actually heard from you.
 */

/** LinkedIn's own caps. The editor enforces the same numbers before you approve. */
export const CHAR_LIMITS: Record<OutreachChannel, number> = {
  CONNECTION_NOTE: 300,
  DIRECT_MESSAGE: 8000,
  INMAIL: 1900,
};

export class SendFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendFailed';
  }
}

const first = (page: Page, selectors: string[]) => page.locator(selectors.join(', ')).first();
const exists = async (page: Page, selectors: string[]) =>
  first(page, selectors)
    .count()
    .then((n) => n > 0)
    .catch(() => false);

/**
 * Send a connection invitation carrying a note.
 *
 * Free LinkedIn accounts are limited to a handful of *personalised* invitations
 * a month. When that allowance is gone LinkedIn simply stops offering the "Add
 * a note" button, and the honest thing to do is stop: sending a bare invitation
 * instead would deliver something the human never read and never approved.
 */
async function sendConnectionNote(page: Page, body: string): Promise<void> {
  const connect = first(page, [
    'button[aria-label^="Invite"][aria-label*="connect"]',
    'button:has-text("Connect")',
  ]);

  if (!(await connect.count().then((n) => n > 0).catch(() => false))) {
    // On narrow layouts and for some relationships Connect is folded into the
    // overflow menu rather than shown inline.
    const more = first(page, ['button[aria-label="More actions"]', 'button:has-text("More")']);
    if (!(await more.count().then((n) => n > 0).catch(() => false))) {
      throw new SendFailed(
        'No Connect button on this profile. You may already be connected (in which case this ' +
          'should be a direct message), or the profile restricts invitations.',
      );
    }
    await more.click({ timeout: 5000 });
    await page.waitForTimeout(600);
    await first(page, ['div[role="menu"] :text("Connect")']).click({ timeout: 5000 });
  } else {
    await connect.click({ timeout: 5000 });
  }
  await page.waitForTimeout(900);

  const addNote = first(page, [
    'button[aria-label="Add a note"]',
    'button:has-text("Add a note")',
  ]);
  if (!(await addNote.count().then((n) => n > 0).catch(() => false))) {
    throw new SendFailed(
      'LinkedIn did not offer "Add a note" on this invitation. Free accounts get only a few ' +
        'personalised invitations a month, and this one appears to be spent. Nothing was sent — ' +
        'a bare invitation without your note is not what you approved.',
    );
  }
  await addNote.click({ timeout: 5000 });
  await page.waitForTimeout(500);

  const note = first(page, ['textarea#custom-message', 'textarea[name="message"]', 'dialog textarea']);
  await note.fill(body, { timeout: 8000 });
  await page.waitForTimeout(400);

  await first(page, [
    'button[aria-label="Send invitation"]',
    'button[aria-label="Send now"]',
    'dialog button:has-text("Send")',
  ]).click({ timeout: 8000 });
}

/** Message someone already connected to. */
async function sendDirectMessage(page: Page, body: string, resumePath?: string): Promise<void> {
  const message = first(page, [
    'button[aria-label^="Message"]',
    'button:has-text("Message")',
  ]);
  if (!(await message.count().then((n) => n > 0).catch(() => false))) {
    throw new SendFailed(
      'No Message button on this profile. LinkedIn only opens the message box for existing ' +
        'connections and open-profile members.',
    );
  }
  await message.click({ timeout: 5000 });
  await page.waitForTimeout(1000);

  const box = first(page, [
    'div.msg-form__contenteditable[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ]);
  await box.click({ timeout: 8000 });
  // A contenteditable ignores fill(); typing is what produces the input events
  // LinkedIn's own draft handling listens for.
  await box.type(body, { delay: 12 });
  await page.waitForTimeout(500);

  if (resumePath) {
    let upload = page.locator('input[type="file"]').last();
    if (!(await upload.count())) {
      const attach = first(page, [
        'button[aria-label*="Attach" i]',
        'button[aria-label*="file" i]',
        'button:has-text("Attach")',
      ]);
      if (await attach.count()) {
        await attach.click({ timeout: 5000 });
        await page.waitForTimeout(400);
        upload = page.locator('input[type="file"]').last();
      }
    }
    if (!(await upload.count())) {
      throw new SendFailed('LinkedIn did not expose a file attachment control. Nothing was sent.');
    }
    await upload.setInputFiles(resumePath);
    await page.waitForTimeout(1000);
  }

  const send = first(page, ['button.msg-form__send-button', 'button:has-text("Send")']);
  const deadline = Date.now() + (resumePath ? 15_000 : 1_000);
  while (Date.now() < deadline && await send.isDisabled().catch(() => false)) {
    await page.waitForTimeout(500);
  }
  if (await send.isDisabled().catch(() => false)) {
    throw new SendFailed('LinkedIn left the Send button disabled, so the message box never took the text.');
  }
  await send.click({ timeout: 8000 });
}

/**
 * Confirm with LinkedIn's own UI that something left.
 *
 * "Pending" replacing Connect, or the compose window closing, are the two
 * states LinkedIn actually reaches on success.
 */
async function verifySent(page: Page, channel: OutreachChannel): Promise<void> {
  await page.waitForTimeout(1600);

  if (channel === 'CONNECTION_NOTE') {
    const pending = await exists(page, [
      'button:has-text("Pending")',
      'button[aria-label*="Pending"]',
      'span:has-text("Invitation sent")',
    ]);
    if (!pending) {
      throw new SendFailed(
        'Clicked Send, but the profile still does not show a pending invitation. Check the ' +
          'browser window — the invitation may have been rejected by a limit, or the dialog may ' +
          'still be open with an error.',
      );
    }
    return;
  }

  const composerStillOpen = await exists(page, ['div.msg-form__contenteditable:not(:empty)']);
  if (composerStillOpen) {
    throw new SendFailed(
      'Clicked Send, but the compose box still holds the text, so the message did not go.',
    );
  }
}

export interface SendRequest {
  profileUrl: string;
  channel: OutreachChannel;
  /** Exactly what the human approved. Never generated here. */
  body: string;
  /** Absolute path to the candidate's approved/default resume. */
  resumePath?: string;
}

/**
 * Deliver one approved message.
 *
 * Throws rather than returning a status, so a caller cannot mistake a failure
 * for a send by forgetting to check a boolean.
 */
export async function sendOutreach(page: Page, req: SendRequest): Promise<void> {
  const body = req.body.trim();
  if (!body) throw new SendFailed('Refusing to send an empty message.');

  const limit = CHAR_LIMITS[req.channel];
  if (body.length > limit) {
    throw new SendFailed(
      `The message is ${body.length} characters and LinkedIn caps a ${req.channel} at ${limit}. ` +
        'Shorten it and try again — truncating it here would send something you did not write.',
    );
  }

  if (req.channel === 'INMAIL') {
    throw new SendFailed(
      'InMail is drafted but never sent automatically: it spends a paid credit, and LinkedIn ' +
        'charges it whether or not the recipient replies. Copy the text and send it yourself.',
    );
  }

  await openLinkedIn(page, req.profileUrl);
  await page.waitForTimeout(config.linkedinDelayMs);

  if (req.channel === 'CONNECTION_NOTE') await sendConnectionNote(page, body);
  else await sendDirectMessage(page, body, req.resumePath);

  await verifySent(page, req.channel);
}

/** The channel to use for someone, given how far away they are. */
export function channelFor(degree: string | null | undefined): OutreachChannel {
  return degree === '1st' ? 'DIRECT_MESSAGE' : 'CONNECTION_NOTE';
}
