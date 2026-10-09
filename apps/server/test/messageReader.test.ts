import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { openThreadInDocument, orderMessages, threadLinksInDocument } from '../src/linkedin/messageReader.js';

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });

async function open(html: string) {
  page = await browser.newPage();
  await page.setContent(html);
  return page;
}

/** One sender's run of messages, the way LinkedIn groups them. */
const group = (from: 'me' | 'them', bodies: string[], time = '') => `
  <li class="msg-s-message-list__event">
    <div class="${from === 'them' ? 'msg-s-event-listitem--other' : 'msg-s-event-listitem'}">
      <a class="msg-s-message-group__profile-link" href="#">${from === 'them' ? 'Cara' : 'Ada'}</a>
      ${time ? `<time datetime="${time}">then</time>` : ''}
      ${bodies.map((body) => `<p class="msg-s-event-listitem__body">${body}</p>`).join('')}
    </div>
  </li>`;

const thread = (events: string) => `
  <div class="msg-thread"><a href="https://www.linkedin.com/in/cara-nguyen?trk=msg">Cara Nguyen</a></div>
  <ul class="msg-s-message-list-content">${events}</ul>`;

describe('reading one conversation', () => {
  it('reads the participant and both directions, carrying direction across a run', async () => {
    await open(thread(group('me', ['Hi Cara, are you hiring?']) + group('them', ['We are', 'Send me your resume'])));
    const read = await page.evaluate(openThreadInDocument);
    expect(read?.profileHref).toBe('https://www.linkedin.com/in/cara-nguyen?trk=msg');
    expect(read?.messages.map((message) => [message.body, message.isFromMe])).toEqual([
      ['Hi Cara, are you hiring?', true],
      ['We are', false],
      // No heading of its own, so it inherits the sender above it.
      ['Send me your resume', false],
    ]);
  });

  it('reads a thread where they spoke last, which is what decides the turn', async () => {
    await open(thread(group('me', ['Following up']) + group('them', ['Sorry for the delay'])));
    const read = await page.evaluate(openThreadInDocument);
    expect(read?.messages.at(-1)).toMatchObject({ body: 'Sorry for the delay', isFromMe: false });
  });

  it('keeps a real timestamp when LinkedIn renders one', async () => {
    await open(thread(group('them', ['Hello'], '2026-09-08T10:32:00.000Z')));
    expect((await page.evaluate(openThreadInDocument))?.messages[0]?.iso).toBe('2026-09-08T10:32:00.000Z');
  });

  it('skips blank message bodies rather than storing empty messages', async () => {
    await open(thread(group('them', ['Hello', '   ', ''])));
    expect((await page.evaluate(openThreadInDocument))?.messages.map((m) => m.body)).toEqual(['Hello']);
  });

  it('returns nothing for a page that is not a conversation', async () => {
    await open('<div>Signed out</div>');
    expect(await page.evaluate(openThreadInDocument)).toBeNull();
  });

  it('lists each thread once, however many links point at it', async () => {
    await open(`<ul>
      <li><a href="/messaging/thread/2-abc==/">Cara</a><a href="/messaging/thread/2-abc==/">Cara again</a></li>
      <li><a href="https://www.linkedin.com/messaging/thread/2-def==/?foo=1">Sam</a></li>
    </ul>`);
    expect(await page.evaluate(threadLinksInDocument)).toEqual(['2-abc==', '2-def==']);
  });
});

describe('giving messages a sortable time', () => {
  const readAt = new Date('2026-09-09T12:00:00.000Z');
  const message = (body: string, sentAt: Date | null) =>
    ({ linkedinMessageId: body, body, isFromMe: false, sentAt });

  it('keeps the reading order when LinkedIn showed no parseable time', () => {
    const ordered = orderMessages([message('first', null), message('second', null), message('third', null)], readAt);
    expect(ordered.map((m) => m.sentAt.getTime())).toEqual([
      readAt.getTime() - 2, readAt.getTime() - 1, readAt.getTime(),
    ]);
    // The newest message is the whole signal: it decides whose turn it is.
    expect(ordered.at(-1)?.body).toBe('third');
    expect([...ordered].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0]?.body).toBe('third');
  });

  it('prefers a real timestamp over its position', () => {
    const real = new Date('2026-09-01T09:00:00.000Z');
    expect(orderMessages([message('dated', real), message('undated', null)], readAt).map((m) => m.sentAt))
      .toEqual([real, readAt]);
  });
});
