import type { Page } from 'playwright';
import { config } from '../lib/config.js';
import { canonicalProfileUrl } from './normalize.js';

export interface ReadMessage {
  linkedinMessageId: string;
  body: string;
  isFromMe: boolean;
  /** Best effort. See {@link orderMessages} for what happens when it is null. */
  sentAt: Date | null;
}

/** A message once {@link orderMessages} has guaranteed it a sortable time. */
export type StoredMessage = ReadMessage & { sentAt: Date };

export interface ReadThread {
  linkedinThreadId: string;
  profileUrl: string;
  messages: StoredMessage[];
}

/**
 * Reading the message history.
 *
 * This exists to answer one question the connections list could not: have I
 * actually spoken to this person. Without it, "not contacted" means "not
 * contacted through this tool", which is a different and much less useful
 * claim for anyone who has been on LinkedIn for a decade.
 *
 * Two things here are deliberately structural rather than selector-driven,
 * because LinkedIn's generated class names churn:
 *
 *  - Direction. Rather than trusting one CSS class, a message is "from me"
 *    when it is NOT marked as the other participant's. LinkedIn marks the
 *    other side (`--other`), and groups consecutive messages under one sender
 *    heading, so direction is inherited from the nearest heading above.
 *  - Order. DOM order is oldest-first and is trustworthy even when the
 *    timestamps are not, so it is preserved separately from `sentAt`.
 */

/** Self-contained because Playwright executes this function in the page. */
export function threadLinksInDocument(): string[] {
  // A plain array rather than a Set: this runs in the page, where the return
  // value has to survive serialisation, and a Set does not.
  const ids: string[] = [];
  for (const anchor of Array.prototype.slice.call(
    document.querySelectorAll('a[href*="/messaging/thread/"]'),
  ) as HTMLAnchorElement[]) {
    const id = (anchor.getAttribute('href') ?? '').match(/\/messaging\/thread\/([^/?#]+)/)?.[1];
    // The list renders the avatar and the name as two links to one thread.
    if (id && ids.indexOf(id) === -1) ids.push(id);
  }
  return ids;
}

/** Self-contained because Playwright executes this function in the page. */
export function openThreadInDocument() {
  const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const root = document.querySelector('.msg-s-message-list-content, .msg-s-message-list, [role="main"]');
  if (!root) return null;

  // The participant's profile link. The thread header carries it; failing
  // that, any /in/ link inside the header region will do.
  const header = document.querySelector('.msg-thread, .msg-entity-lockup, header') ?? document;
  const profileHref = Array.prototype.slice.call(
    header.querySelectorAll('a[href*="/in/"]'),
  ).map((a: HTMLAnchorElement) => a.href)[0]
    ?? Array.prototype.slice.call(
      document.querySelectorAll('.msg-thread a[href*="/in/"], .msg-title-bar a[href*="/in/"]'),
    ).map((a: HTMLAnchorElement) => a.href)[0]
    ?? '';

  const events = Array.prototype.slice.call(
    root.querySelectorAll('.msg-s-message-list__event, li.msg-s-message-list__event, [data-event-urn]'),
  ) as HTMLElement[];

  const messages: { id: string; body: string; isFromMe: boolean; iso: string }[] = [];
  // Direction is carried down from the last sender heading, because LinkedIn
  // only labels the first message of a run.
  let fromMe = true;

  for (const event of events) {
    const other = event.querySelector('.msg-s-event-listitem--other')
      ?? (event.classList.contains('msg-s-event-listitem--other') ? event : null);
    const heading = event.querySelector('.msg-s-message-group__profile-link, .msg-s-message-group__name');
    if (heading || other) fromMe = !other;

    for (const item of Array.prototype.slice.call(
      event.querySelectorAll('.msg-s-event-listitem__body, .msg-s-event__content p'),
    ) as HTMLElement[]) {
      const body = clean(item.innerText);
      if (!body) continue;
      const time = event.querySelector('time');
      messages.push({
        id: clean(event.getAttribute('data-event-urn')) || `${messages.length}:${body.slice(0, 60)}`,
        body,
        isFromMe: fromMe,
        iso: time?.getAttribute('datetime') ?? '',
      });
    }
  }

  return { profileHref, messages };
}

/**
 * Give every message a `sentAt` that sorts the way the thread reads.
 *
 * LinkedIn renders "10:32 AM" and a separate day separator, so a per-message
 * timestamp is often unparseable. Falling back to "now" for all of them would
 * make the newest message ambiguous, and the newest message is the entire
 * signal - it decides whose turn it is. So an unparseable message borrows its
 * position instead: one millisecond apart, in DOM order, ending at `readAt`.
 * The absolute times are then approximate and the ordering is exact, which is
 * the right way round for what this feeds.
 */
export function orderMessages(messages: ReadMessage[], readAt: Date): StoredMessage[] {
  const total = messages.length;
  return messages.map((message, index) => ({
    ...message,
    sentAt: message.sentAt ?? new Date(readAt.getTime() - (total - 1 - index)),
  }));
}

/** Read every conversation LinkedIn will show us. */
export async function readConversations(page: Page, options: {
  maxThreads?: number;
  delayMs?: number;
  onThread?: (thread: ReadThread) => Promise<void>;
} = {}): Promise<ReadThread[]> {
  const delay = options.delayMs ?? Math.max(800, config.linkedinDelayMs);
  const threads: ReadThread[] = [];

  if (/\/(authwall|login|uas\/login|checkpoint|signup)\b/.test(new URL(page.url()).pathname)) {
    throw new Error('LinkedIn needs sign-in or verification. Complete it in the Job Applier browser, then sync again.');
  }

  const ids = (await page.evaluate(threadLinksInDocument)).slice(0, options.maxThreads ?? 200);

  for (const id of ids) {
    await page.goto(`https://www.linkedin.com/messaging/thread/${id}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(delay);

    const read = await page.evaluate(openThreadInDocument);
    if (!read || !read.messages.length) continue;

    let profileUrl: string | null;
    try { profileUrl = canonicalProfileUrl(read.profileHref); } catch { continue; }
    if (!profileUrl) continue;

    const readAt = new Date();
    const thread: ReadThread = {
      linkedinThreadId: id,
      profileUrl,
      messages: orderMessages(
        read.messages.map((message) => ({
          linkedinMessageId: message.id,
          body: message.body,
          isFromMe: message.isFromMe,
          sentAt: message.iso ? new Date(message.iso) : null,
        })).filter((message) => !message.sentAt || !Number.isNaN(message.sentAt.getTime())),
        readAt,
      ),
    };
    threads.push(thread);
    await options.onThread?.(thread);
  }

  return threads;
}
