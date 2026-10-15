import tls from 'node:tls';

/**
 * Reading your own Gmail for the codes job sites email you.
 *
 * Plain IMAP over TLS with a Google app password, written against node:tls
 * rather than an IMAP library: the job needs five commands (LOGIN, LIST,
 * EXAMINE, UID SEARCH, UID FETCH), all read-only, and nothing here is worth a
 * dependency. EXAMINE rather than SELECT and BODY.PEEK rather than BODY, so
 * nothing is marked read and nothing in the mailbox changes.
 *
 * Works for any Google account, gmail.com or Workspace. An app password is the
 * only credential IMAP takes once 2-Step Verification is on; it can read mail
 * and nothing else, and you can revoke it without touching your real password.
 */

const HOST = 'imap.gmail.com';
const PORT = 993;
const COMMAND_TIMEOUT_MS = 20_000;

export interface InboxMessage {
  /** `mailbox:uid`, unique within the account. */
  key: string;
  receivedAt: Date;
  from: string;
  subject: string;
  /** Plain text, or the HTML part flattened to text when there is no plain one. */
  text: string;
  links: Array<{ url: string; text: string }>;
}

interface Response {
  text: string;
  literals: Buffer[];
}

class ImapConnection {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private failure: Error | null = null;
  private tag = 0;

  private constructor(private readonly socket: tls.TLSSocket) {
    socket.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    socket.on('error', (err) => {
      this.failure = err;
      this.wake();
    });
    socket.on('close', () => {
      this.failure ??= new Error('Gmail closed the IMAP connection.');
      this.wake();
    });
  }

  static async open(): Promise<ImapConnection> {
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ host: HOST, port: PORT, servername: HOST });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('Could not reach imap.gmail.com.'));
      }, COMMAND_TIMEOUT_MS);
      s.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const conn = new ImapConnection(socket);
    // The greeting: "* OK Gimap ready".
    await conn.read(Date.now() + COMMAND_TIMEOUT_MS);
    return conn;
  }

  private wake() {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }

  private more(deadline: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gmail stopped answering.')), Math.max(0, deadline - Date.now()));
      this.waiters.push(() => {
        clearTimeout(timer);
        if (this.failure) reject(this.failure);
        else resolve();
      });
    });
  }

  /** One logical response line, with any `{n}` literals it carries. */
  private async read(deadline: number): Promise<Response> {
    let text = '';
    const literals: Buffer[] = [];
    for (;;) {
      let end: number;
      while ((end = this.buf.indexOf('\r\n')) < 0) await this.more(deadline);
      const line = this.buf.subarray(0, end).toString('latin1');
      this.buf = this.buf.subarray(end + 2);
      text += line;
      const literal = /\{(\d+)\}$/.exec(line);
      if (!literal) return { text, literals };
      const size = Number(literal[1]);
      while (this.buf.length < size) await this.more(deadline);
      literals.push(Buffer.from(this.buf.subarray(0, size)));
      this.buf = this.buf.subarray(size);
    }
  }

  /** Send one command and return its untagged responses; throws on NO / BAD. */
  async command(cmd: string): Promise<Response[]> {
    const tag = `J${++this.tag}`;
    this.socket.write(`${tag} ${cmd}\r\n`);
    const deadline = Date.now() + COMMAND_TIMEOUT_MS;
    const untagged: Response[] = [];
    for (;;) {
      const res = await this.read(deadline);
      if (!res.text.startsWith(`${tag} `)) {
        untagged.push(res);
        continue;
      }
      const status = res.text.slice(tag.length + 1);
      if (/^OK\b/i.test(status)) return untagged;
      throw new Error(status.replace(/^(NO|BAD)\s+/i, ''));
    }
  }

  close() {
    this.socket.write(`J${++this.tag} LOGOUT\r\n`);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }
}

const quote = (s: string) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;

/** Gmail shows app passwords in four groups of four; IMAP wants them joined. */
const cleanPassword = (p: string) => p.replace(/\s+/g, '');

function loginError(err: unknown): Error {
  const msg = (err as Error).message;
  if (/AUTHENTICATIONFAILED|Invalid credentials/i.test(msg)) {
    return new Error(
      'Gmail refused that email and app password. Check the password is an app password ' +
        '(16 letters, from myaccount.google.com/apppasswords), not your normal one, and that ' +
        'it belongs to the same Google account as your profile email.',
    );
  }
  if (/IMAP access is disabled|ALERT/i.test(msg)) {
    return new Error(`Gmail said: ${msg}. Turn IMAP on in Gmail settings → Forwarding and POP/IMAP.`);
  }
  return err as Error;
}

/** Log in and straight out again: proves the pair works before a run needs it. */
export async function checkInboxLogin(email: string, appPassword: string): Promise<void> {
  const conn = await ImapConnection.open();
  try {
    await conn.command(`LOGIN ${quote(email)} ${quote(cleanPassword(appPassword))}`);
  } catch (err) {
    throw loginError(err);
  } finally {
    conn.close();
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (d: Date) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

/**
 * An open, logged-in inbox that can be asked "anything new since?" repeatedly
 * while a run waits for an email to arrive.
 */
export class Inbox {
  private mailboxes: string[] = ['INBOX'];

  private constructor(private readonly conn: ImapConnection) {}

  static async open(email: string, appPassword: string): Promise<Inbox> {
    const conn = await ImapConnection.open();
    try {
      await conn.command(`LOGIN ${quote(email)} ${quote(cleanPassword(appPassword))}`);
    } catch (err) {
      conn.close();
      throw loginError(err);
    }
    const inbox = new Inbox(conn);
    // Spam too: a first email from a job site's mailer lands there often enough.
    const lists = await conn.command('LIST "" "*"').catch(() => [] as Response[]);
    for (const { text } of lists) {
      if (!/\\Junk\b/i.test(text)) continue;
      const name = /"((?:[^"\\]|\\.)*)"\s*$/.exec(text)?.[1];
      if (name) inbox.mailboxes.push(name.replace(/\\(.)/g, '$1'));
    }
    return inbox;
  }

  /**
   * Messages received at or after `since` that are not in `skip`, newest
   * first. At most `limit` per mailbox are downloaded, so a busy inbox does
   * not turn one poll into a download of the whole day.
   */
  async since(since: Date, skip: Set<string>, limit = 12): Promise<InboxMessage[]> {
    const found: InboxMessage[] = [];
    // SEARCH SINCE is whole days in the server's zone; a day early, then exact.
    const day = new Date(since.getTime() - 24 * 3600_000);
    for (const mailbox of this.mailboxes) {
      // Re-examining also makes the server notice mail that arrived since last time.
      await this.conn.command(`EXAMINE ${quote(mailbox)}`);
      const search = await this.conn.command(`UID SEARCH SINCE ${imapDate(day)}`);
      const uids = search
        .flatMap((r) => (/^\* SEARCH\b/i.test(r.text) ? r.text.slice(8).trim().split(/\s+/) : []))
        .filter((u) => /^\d+$/.test(u))
        .map(Number)
        .sort((a, b) => b - a)
        .filter((uid) => !skip.has(`${mailbox}:${uid}`))
        .slice(0, limit);
      for (const uid of uids) {
        const key = `${mailbox}:${uid}`;
        const res = await this.conn.command(`UID FETCH ${uid} (INTERNALDATE BODY.PEEK[])`);
        const fetched = res.find((r) => /\bFETCH\b/i.test(r.text) && r.literals.length);
        if (!fetched) continue;
        const date = /INTERNALDATE "([^"]+)"/i.exec(fetched.text)?.[1];
        // "15-Oct-2026 10:01:02 +0000" -> a form Date.parse takes.
        const receivedAt = new Date(date ? date.replace(/-/, ' ').replace(/-/, ' ') : NaN);
        if (Number.isNaN(receivedAt.getTime()) || receivedAt < since) {
          // Older than asked for, and UIDs only go up: so is everything after it.
          skip.add(key);
          break;
        }
        found.push({ key, receivedAt, ...parseMessage(fetched.literals[0]!) });
      }
    }
    return found.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }

  close() {
    this.conn.close();
  }
}

// ---------------------------------------------------------------------------
// MIME, just enough of it: headers, multipart, base64 / quoted-printable,
// charsets, and RFC 2047 subjects.

function splitHead(raw: Buffer): [string, Buffer] {
  let at = raw.indexOf('\r\n\r\n');
  let gap = 4;
  if (at < 0) {
    at = raw.indexOf('\n\n');
    gap = 2;
  }
  if (at < 0) return [raw.toString('latin1'), Buffer.alloc(0)];
  return [raw.subarray(0, at).toString('latin1'), raw.subarray(at + gap)];
}

function parseHeaders(head: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

function param(value: string, name: string): string | undefined {
  return new RegExp(`;\\s*${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(value)?.slice(1).find((v) => v !== undefined);
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function decodeQuotedPrintable(s: string): Buffer {
  return Buffer.from(
    s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  );
}

function decodeTransfer(body: Buffer, encoding: string): Buffer {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body.toString('latin1'));
  return body;
}

/** `=?UTF-8?B?...?=` and `=?UTF-8?Q?...?=` words in a header. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BQbq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset: string, kind: string, data: string) => {
      const bytes =
        kind.toUpperCase() === 'B'
          ? Buffer.from(data, 'base64')
          : decodeQuotedPrintable(data.replace(/_/g, ' '));
      return decodeCharset(bytes, charset);
    });
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", zwnj: '' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|td|th|li|h[1-6]|table|span)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0\u200b-\u200d]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function collectParts(raw: Buffer, out: { plain: string[]; html: string[] }, depth = 0): void {
  if (depth > 6) return;
  const [head, body] = splitHead(raw);
  const headers = parseHeaders(head);
  const contentType = headers.get('content-type') ?? 'text/plain';
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(contentType, 'boundary');
    if (!boundary) return;
    const segments = body.toString('latin1').split(`--${boundary}`).slice(1);
    for (const segment of segments) {
      if (segment.startsWith('--')) break;
      collectParts(Buffer.from(segment.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), 'latin1'), out, depth + 1);
    }
    return;
  }
  if (type !== 'text/plain' && type !== 'text/html') return;
  if (/attachment/i.test(headers.get('content-disposition') ?? '')) return;
  const text = decodeCharset(
    decodeTransfer(body, headers.get('content-transfer-encoding') ?? ''),
    param(contentType, 'charset'),
  );
  (type === 'text/html' ? out.html : out.plain).push(text);
}

export function parseMessage(raw: Buffer): Omit<InboxMessage, 'key' | 'receivedAt'> {
  const [head] = splitHead(raw);
  const headers = parseHeaders(head);
  const parts = { plain: [] as string[], html: [] as string[] };
  collectParts(raw, parts);

  const links: Array<{ url: string; text: string }> = [];
  for (const html of parts.html) {
    for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      links.push({ url: decodeEntities(m[1] ?? '').trim(), text: htmlToText(m[2] ?? '') });
    }
  }
  const htmlText = parts.html.map(htmlToText).join('\n');
  const plain = parts.plain.join('\n');
  for (const m of plain.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) links.push({ url: m[0], text: '' });

  return {
    from: decodeWords(headers.get('from') ?? ''),
    subject: decodeWords(headers.get('subject') ?? ''),
    // HTML-only mail is the norm from ATS mailers; its flattened text puts a
    // code in its own table cell onto its own line, which is what findCode
    // trusts most.
    text: htmlText || plain,
    links: links.filter((l) => /^https?:\/\//i.test(l.url)),
  };
}

// ---------------------------------------------------------------------------
// What is in the email.

/** Does this look like an email asking you to verify something? */
export function isVerificationEmail(msg: Pick<InboxMessage, 'subject' | 'text'>): boolean {
  return /verif|passcode|one[- ]time|\botp\b|security code|confirm your (email|account)|activate your account|\bcode\b/i.test(
    `${msg.subject}\n${msg.text.slice(0, 4000)}`,
  );
}

const YEAR = /^(19|20)\d\d$/;
// At least one digit: a bare word is never the code, and "R12345"-style job
// ids lose to a code on its own line anyway.
const TOKEN = /\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,10}\b/g;
const KEYWORD = /\b(code|passcode|otp|one[- ]time (?:password|code|pin)|pin)\b/gi;

/**
 * The code in a verification email, or null when it is not clear which one.
 *
 * Trusts, in order: a line that is nothing but the code (how almost every ATS
 * lays it out), then the first code-shaped token shortly after the word
 * "code". Never guesses between two different standalone codes - a wrong code
 * costs more than a pause.
 */
export function findCode(msg: Pick<InboxMessage, 'subject' | 'text'>): string | null {
  const standalone = new Set<string>();
  for (const line of msg.text.split('\n')) {
    const trimmed = line.trim();
    // "123456", "123 456", "1 2 3 4 5 6", "123-456".
    if (/^\d[\d \-]{2,14}\d$/.test(trimmed)) {
      const joined = trimmed.replace(/[ -]/g, '');
      if (joined.length >= 4 && joined.length <= 8 && !YEAR.test(joined)) standalone.add(joined);
      continue;
    }
    if (/^[A-Za-z0-9]{4,10}$/.test(trimmed) && /\d/.test(trimmed) && !YEAR.test(trimmed)) standalone.add(trimmed);
  }

  const nearKeyword: string[] = [];
  for (const source of [msg.subject, msg.text]) {
    for (const k of source.matchAll(KEYWORD)) {
      const after = source.slice(k.index! + k[0].length, k.index! + k[0].length + 80);
      const token = Array.from(after.matchAll(TOKEN))
        .map((t) => t[0])
        .find((t) => !YEAR.test(t));
      if (token) nearKeyword.push(token);
    }
  }

  if (standalone.size === 1) return [...standalone][0] ?? null;
  if (standalone.size > 1) return nearKeyword.find((t) => standalone.has(t)) ?? null;
  return nearKeyword[0] ?? null;
}

/** The "verify your email" button, when the email has a link instead of a code. */
export function findVerifyLink(msg: Pick<InboxMessage, 'links'>): string | null {
  const bad = /unsubscribe|privacy|terms|help|support|preferences|mailto:|facebook|twitter|linkedin\.com|instagram/i;
  const good = /verif|confirm|activat|validat/i;
  const hit =
    msg.links.find((l) => good.test(l.text) && !bad.test(l.url)) ??
    msg.links.find((l) => good.test(l.url) && !bad.test(l.url));
  return hit?.url ?? null;
}

/** Applicant-tracking mailers that send on a company's behalf. */
const ATS_MAILERS =
  /myworkday|workday|greenhouse|lever\.co|icims|smartrecruiters|successfactors|sapsf|taleo|oracle|workable|ashbyhq|jobvite|bamboohr|turbohire|darwinbox|phenom|eightfold|avature|brassring|recruitee|teamtailor|personio|keka|zohorecruit/i;

const GENERIC_LABELS =
  /^(www\d*|careers?|jobs?|apply|recruiting|recruit|hire|hiring|talent|portal|external|site|login|secure|auth|ats|boards?|en|us|eu|com|net|org|io|co|in|ai|app|gov|edu|wd\d+|myworkdayjobs|myworkdaysite|greenhouse|lever|icims|smartrecruiters|successfactors|taleo|oraclecloud|workable|ashbyhq|jobvite)$/i;

/** Words in a job site's host that name the company: cisco.wd5.myworkdayjobs.com -> ["cisco"]. */
export function companyHints(pageUrl: string, company?: string | null): string[] {
  let host = '';
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    /* no host hints */
  }
  const hints = host
    .split('.')
    .flatMap((label) => label.split('-'))
    .filter((l) => l.length >= 3 && !GENERIC_LABELS.test(l));
  const fromName = (company ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^(inc|ltd|llc|the|and|pvt|private|limited|corp|corporation|technologies|technology|group|india|labs|company|systems|solutions|software|services|global|international|careers|trading)$/.test(w));
  return [...new Set([...hints.map((h) => h.toLowerCase()), ...fromName])];
}

/** 2 = from or about this company, 1 = an ATS mailer, 0 = unrelated. */
export function relevance(msg: Pick<InboxMessage, 'from' | 'subject' | 'text'>, hints: string[]): number {
  const haystack = `${msg.from}\n${msg.subject}\n${msg.text.slice(0, 3000)}`.toLowerCase();
  if (hints.some((h) => haystack.includes(h))) return 2;
  if (ATS_MAILERS.test(msg.from)) return 1;
  return 0;
}
