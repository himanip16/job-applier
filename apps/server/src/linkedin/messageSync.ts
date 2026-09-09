import { prisma } from '../lib/db.js';
import { openLinkedIn, linkedInPage } from './session.js';
import { readConversations, type ReadThread } from './messageReader.js';

/**
 * Persist the LinkedIn message history.
 *
 * A thread only matters here if it belongs to someone already in `contacts`.
 * The messaging inbox is full of recruiters you never connected to, group
 * threads and InMail, and importing all of it would fill the connections list
 * with people who are not connections. Anything unmatched is skipped quietly
 * and counted, so the number is visible without being an error.
 */
export async function syncMessages(profileId: string): Promise<{
  threads: number;
  messages: number;
  unmatched: number;
  /** One entry per thread that could not be saved. The sync itself still ran. */
  errors: string[];
  /**
   * Set when the sync never got going at all - not signed in, LinkedIn
   * challenged the session, the inbox would not load.
   *
   * Kept separate from `errors` because the two mean opposite things to the
   * person reading them. A thread-level error is "39 of 40 worked"; this is
   * "nothing happened and here is why". Folding the second into the first is
   * how a failed sync came to render as "Read 0 messages across 0
   * conversations. 1 could not be saved." - technically true, and it told you
   * nothing about the sign-in you actually needed to do.
   */
  fatalError: string | null;
}> {
  const result = {
    threads: 0,
    messages: 0,
    unmatched: 0,
    errors: [] as string[],
    fatalError: null as string | null,
  };

  await prisma.linkedInSync.upsert({
    where: { profileId_syncType: { profileId, syncType: 'MESSAGES' } },
    update: { status: 'RUNNING', error: null },
    create: { profileId, syncType: 'MESSAGES', status: 'RUNNING' },
  });

  let page: Awaited<ReturnType<typeof linkedInPage>> | null = null;
  try {
    page = await linkedInPage();
    await openLinkedIn(page, 'https://www.linkedin.com/messaging/');

    await readConversations(page, {
      onThread: async (thread) => {
        try {
          const saved = await saveThread(profileId, thread);
          if (saved === null) result.unmatched++;
          else { result.threads++; result.messages += saved; }
        } catch (err) {
          result.errors.push(`${thread.profileUrl}: ${(err as Error).message}`);
        }
      },
    });

    await prisma.linkedInSync.upsert({
      where: { profileId_syncType: { profileId, syncType: 'MESSAGES' } },
      update: { status: 'COMPLETED', lastSyncAt: new Date(), error: null },
      create: { profileId, syncType: 'MESSAGES', status: 'COMPLETED', lastSyncAt: new Date() },
    });
  } catch (err) {
    const error = (err as Error).message;
    result.fatalError = error;
    await prisma.linkedInSync.upsert({
      where: { profileId_syncType: { profileId, syncType: 'MESSAGES' } },
      update: { status: 'FAILED', error },
      create: { profileId, syncType: 'MESSAGES', status: 'FAILED', error },
    });
  } finally {
    await page?.close().catch(() => {});
  }

  return result;
}

/**
 * Store one thread. Returns the message count, or null when the participant is
 * not one of your contacts.
 *
 * Messages are keyed on LinkedIn's own event id, so re-syncing an existing
 * thread updates rather than duplicating it - which matters because the
 * connections list reads only the newest row and a duplicated tail would make
 * the turn ambiguous.
 */
async function saveThread(profileId: string, thread: ReadThread): Promise<number | null> {
  const contact = await prisma.contact.findUnique({
    where: { profileId_profileUrl: { profileId, profileUrl: thread.profileUrl } },
    select: { id: true },
  });
  if (!contact) return null;

  // Messages arrive oldest-first, so the tail is the newest either way.
  const lastMessageAt = thread.messages.at(-1)?.sentAt ?? new Date();
  const conversation = await prisma.linkedInConversation.upsert({
    where: { profileId_linkedinConversationId: { profileId, linkedinConversationId: thread.linkedinThreadId } },
    update: { contactId: contact.id, lastMessageAt, lastSyncedAt: new Date() },
    create: {
      profileId,
      contactId: contact.id,
      linkedinConversationId: thread.linkedinThreadId,
      linkedinProfileUrl: thread.profileUrl,
      lastMessageAt,
      lastSyncedAt: new Date(),
    },
    select: { id: true },
  });

  for (const message of thread.messages) {
    await prisma.linkedInMessage.upsert({
      where: {
        conversationId_linkedinMessageId: {
          conversationId: conversation.id,
          linkedinMessageId: message.linkedinMessageId,
        },
      },
      update: { body: message.body, isFromMe: message.isFromMe, sentAt: message.sentAt },
      create: {
        conversationId: conversation.id,
        linkedinMessageId: message.linkedinMessageId,
        senderProfileUrl: message.isFromMe ? '' : thread.profileUrl,
        body: message.body,
        isFromMe: message.isFromMe,
        sentAt: message.sentAt,
      },
    });
  }

  return thread.messages.length;
}
