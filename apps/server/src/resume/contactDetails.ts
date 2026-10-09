/**
 * Contact details, read straight off a resume's text.
 *
 * The top of every resume states who you are and how to reach you, so the
 * profile form should not make you type it again. Plain pattern matching: no
 * model call, no cost, and the result is only ever a suggestion - it fills
 * empty boxes, and you save it yourself.
 */
export interface ContactDetails {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  github?: string;
  website?: string;
  city?: string;
  region?: string;
  country?: string;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const LINKEDIN = /(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/in\/([\w%-]+)/i;
const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w-]+)/i;
const URL = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:dev|io|me|com|in|co|net|org|app|site)(?:\/[\w./@%~-]*)?/gi;
/** A phone number has at least ten digits; dates and years never do. */
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s.-]?){2,5}\d{2,5}/g;

export function contactDetailsFrom(resumeText: string): ContactDetails {
  const text = resumeText.replace(/\r/g, '');
  const head = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12);
  const out: ContactDetails = {};

  out.email = text.match(EMAIL)?.[0];

  const li = text.match(LINKEDIN)?.[1];
  if (li) out.linkedin = `https://www.linkedin.com/in/${li.replace(/\/$/, '')}/`;
  const gh = text.match(GITHUB)?.[1];
  if (gh) out.github = `https://github.com/${gh}`;

  // The first other link: from the PDF's own links when it had them, since
  // those are complete, else the first address written in the header.
  const listed = text.match(/\nLinks: (.+)$/)?.[1]?.split(' ') ?? [];
  const other = listed.find((u) => !/linkedin\.com|github\.com|mailto:/i.test(u));
  if (other) out.website = other;
  const emailDomain = out.email?.split('@')[1]?.toLowerCase();
  for (const m of out.website ? [] : head.join(' ').matchAll(URL)) {
    const u = m[0].toLowerCase();
    if (/linkedin\.com|github\.com/.test(u) || (emailDomain && u.endsWith(emailDomain)) || EMAIL.test(m.input?.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + u.length + 1) ?? '')) continue;
    out.website = u.startsWith('http') ? m[0] : `https://${m[0]}`;
    break;
  }

  for (const m of head.join('  ').matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) {
      out.phone = m[0].trim();
      break;
    }
  }

  // The name: the words just before the email, when the text is one run
  // ("Himani h.nprasad068@gmail.com | ..."), else the first short line of words.
  const beforeEmail = out.email
    ? text.slice(0, text.indexOf(out.email)).trim().split(/\s*[|•·\n]\s*/).pop()?.trim()
    : undefined;
  const looksLikeName = (l: string | undefined): l is string =>
    Boolean(l) &&
    /^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,3}$/u.test(l!) &&
    !/resume|curriculum|vitae|engineer|developer|profile|summary/i.test(l!);
  const nameLine = [beforeEmail, ...head].find(looksLikeName);
  if (nameLine) {
    const words = nameLine.split(/\s+/).map((w) => (w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w));
    out.fullName = words.join(' ');
    out.firstName = words[0];
    out.lastName = words.slice(1).join(' ');
  }

  // "Bengaluru, Karnataka, India" or "London, UK": a comma list of place-like
  // words near the top, with no digits or @ in it.
  for (const line of head) {
    for (const part of line.split(/\s*[|•·]\s*/)) {
      const bits = part.split(/\s*,\s*/).filter(Boolean);
      if (bits.length < 2 || bits.length > 3) continue;
      if (!bits.every((b) => /^[\p{Lu}][\p{L} .'-]{1,30}$/u.test(b))) continue;
      out.city = bits[0];
      if (bits.length === 3) {
        out.region = bits[1];
        out.country = bits[2];
      } else {
        out.country = bits[1];
      }
      break;
    }
    if (out.city) break;
  }

  return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as ContactDetails;
}
