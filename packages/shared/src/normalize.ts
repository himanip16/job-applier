/**
 * Label normalisation + a dependency-free lexical similarity model.
 *
 * Why not real embeddings? Two reasons:
 *  1. Anthropic has no embeddings endpoint, so vectors mean adding a second
 *     vendor (Voyage/OpenAI) and a second API key for a workload that is
 *     ~200 short, highly formulaic strings per user.
 *  2. Form labels rhyme. "Are you legally authorized to work in the US?" vs
 *     "Are you legally authorised to work in the United States?" is a lexical
 *     near-duplicate, which char-trigram + token cosine nails.
 *
 * Anything this misses falls through to the LLM, which is the correct place
 * for genuinely semantic matching. `EmbeddingProvider` in the server package
 * lets you swap in dense vectors later without touching callers.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do',
  'does', 'did', 'you', 'your', 'yours', 'we', 'us', 'our', 'i', 'me', 'my',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'if', 'this',
  'that', 'it', 'as', 'by', 'from', 'will', 'would', 'can', 'could', 'have',
  'has', 'had', 'please', 'select', 'choose', 'enter', 'optional', 'required',
]);

/** Spelling variants that should collapse to one token. */
const SYNONYMS: Record<string, string> = {
  authorised: 'authorized',
  authorisation: 'authorization',
  organisation: 'organization',
  organisational: 'organizational',
  'e-mail': 'email',
  mail: 'email',
  cv: 'resume',
  usa: 'us',
  'u.s.': 'us',
  'u.s.a.': 'us',
  'united states': 'us',
  yrs: 'years',
  yr: 'years',
  comp: 'compensation',
  salary: 'compensation',
  ctc: 'compensation',
};

/**
 * Canonical text form of a question label: lowercase, punctuation and
 * required-markers stripped, whitespace collapsed.
 */
export function normalizeLabel(raw: string): string {
  let s = raw
    .replace(/ /g, ' ')
    .toLowerCase()
    .replace(/\(\s*(optional|required)\s*\)/g, ' ')
    .replace(/[*\u2731\uFF0A\u2020\u271A]+/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'/+#. -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [from, to] of Object.entries(SYNONYMS)) {
    s = s.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to);
  }
  return s.replace(/\s+/g, ' ').trim();
}

export function tokenize(normalized: string): string[] {
  return normalized
    .split(/[^a-z0-9'+#.]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function trigrams(normalized: string): string[] {
  const s = ` ${normalized.replace(/\s+/g, ' ')} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= s.length; i++) out.push(s.slice(i, i + 3));
  return out;
}

export type SparseVector = Record<string, number>;

/**
 * Build a sparse, L2-normalised vector combining whole tokens (weighted
 * heavily — they carry the meaning) and char trigrams (which absorb typos,
 * plurals and British/American spelling).
 */
export function vectorize(raw: string): SparseVector {
  const norm = normalizeLabel(raw);
  const vec: SparseVector = {};
  for (const t of tokenize(norm)) vec[`t:${t}`] = (vec[`t:${t}`] ?? 0) + 3;
  for (const g of trigrams(norm)) vec[`g:${g}`] = (vec[`g:${g}`] ?? 0) + 1;
  let mag = 0;
  for (const v of Object.values(vec)) mag += v * v;
  mag = Math.sqrt(mag) || 1;
  for (const k of Object.keys(vec)) vec[k] = vec[k]! / mag;
  return vec;
}

/** Cosine similarity of two L2-normalised sparse vectors: just the dot product. */
export function cosine(a: SparseVector, b: SparseVector): number {
  // Iterate the smaller map.
  const [small, large] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of Object.entries(small)) {
    const w = large[k];
    if (w !== undefined) dot += v * w;
  }
  return dot;
}

/**
 * Two answers are only interchangeable if they were given against compatible
 * option sets. Reusing "Yes" from a yes/no radio on a five-way seniority
 * dropdown would be nonsense, so we check containment before reuse.
 */
export function optionsCompatible(
  stored: { label: string }[] | null | undefined,
  incoming: { label: string }[] | null | undefined,
): boolean {
  if (!incoming || incoming.length === 0) return true;   // free text accepts anything
  if (!stored || stored.length === 0) return true;       // stored free text can be typed in
  const norm = (o: { label: string }) => normalizeLabel(o.label);
  const incomingSet = new Set(incoming.map(norm));
  // Every option we might have picked must still be pickable.
  return stored.some((o) => incomingSet.has(norm(o)));
}
