/** Turning what boards send into text a person and a tokeniser can both read. */

const removeTags = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

const decodeEntities = (text: string): string =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#3[49];|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#(\d{2,5});/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // Last, deliberately: decoding it first would turn `&amp;lt;` straight
    // into `<` and hide a level of escaping from the next pass.
    .replace(/&amp;/g, '&');

/**
 * Turn a board's description into text a human and a tokeniser can both read.
 *
 * Stripping and unescaping have to alternate, not happen once each in that
 * order. Greenhouse returns `content` as HTML that is itself HTML-escaped, so
 * one pass removes no tags at all (there are none yet) and then unescapes
 * `&lt;span style="..."&gt;` into real markup, which lands in the description
 * verbatim. The lexical scorer then learns from it: a live queue had jobs
 * whose top matched terms were `span`, `nbsp` and `props`, and one scored 94%
 * on them.
 *
 * Three passes is enough for the double-escaping seen in the wild, and the
 * loop stops as soon as a pass changes nothing.
 */
export const stripHtml = (html: string): string => {
  let text = html;
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeEntities(removeTags(text));
    if (next === text) break;
    text = next;
  }
  return removeTags(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/**
 * Whether a posting reads as remote, from free text alone.
 *
 * A bare match on the word "remote" is wrong more often than it looks: "hybrid,
 * remote work is not offered for this role" and "3 days/week in office, with
 * remote flexibility for senior staff" both contain the word and describe jobs
 * that are not remote. A live queue had exactly this - a posting tagged REMOTE
 * whose own rationale, read by the model from the same text, correctly said
 * "Hybrid - Bangalore, India".
 *
 * Hybrid/on-site language and any negated form of "remote" both win over a
 * bare mention, and only a genuinely unqualified claim ("remote", "work from
 * anywhere", "fully distributed") counts as yes. This is still a heuristic for
 * the boards with no structured field to ask instead - see the callers that
 * have one and use it as the authority.
 */
export const looksRemote = (s: string): boolean => {
  const text = s.toLowerCase();
  if (/\b(hybrid|on-?site|in-?office|in the office)\b/.test(text)) return false;
  if (/\b(not|no|isn'?t|is not|won'?t be|not currently|does not offer|doesn'?t offer)\b(?:\s+\w+){0,3}\s+remote\b/.test(text)) {
    return false;
  }
  return /\bremote\b|\bwork from (home|anywhere)\b|\bfully distributed\b/.test(text);
};

/**
 * A board's own structured field, when it bothered to send one, over the text
 * guess. "Hybrid" or "on-site" from the source is a fact; a stray "remote" in
 * three paragraphs of benefits copy is a guess, and the fact wins.
 */
export function remoteFrom(structured: 'remote' | 'hybrid' | 'onsite' | 'unspecified', fallbackText: string): boolean {
  if (structured === 'remote') return true;
  if (structured === 'hybrid' || structured === 'onsite') return false;
  return looksRemote(fallbackText);
}

/**
 * Remote or not, from a platform's own work-type label ("remote", "Hybrid",
 * "On-site", "Flexible - Remote OK"), falling back to the free text when the
 * label is missing.
 */
export function remoteFromLabel(label: string | undefined, fallbackText: string): boolean {
  const l = (label ?? '').toLowerCase();
  return remoteFrom(
    l.includes('remote') ? 'remote' : l.includes('hybrid') ? 'hybrid' : l ? 'onsite' : 'unspecified',
    fallbackText,
  );
}
