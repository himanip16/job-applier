import { normalizeLabel, type FieldOption } from '@ja/shared';

const AFFIRMATIVE = new Set(['yes', 'y', 'true', '1', 'yes i am', 'i am', 'authorized', 'agree', 'i agree', 'accept']);
const NEGATIVE = new Set(['no', 'n', 'false', '0', 'not required', 'i do not', 'disagree', 'decline']);
const DECLINE_PATTERNS = [
  /decline to (self.?identify|answer|state|disclose)/i,
  /prefer not to (say|answer|disclose|respond)/i,
  /i (don'?t|do not) wish to answer/i,
  /^not specified$/i,
];

export interface OptionMatch {
  option: FieldOption;
  /** 1 = exact, lower = looser. Below ~0.7 the caller should ask the human. */
  score: number;
}

/**
 * Map a free-form desired answer onto one of a control's actual options.
 *
 * This is where a stored answer of `true` becomes the literal string the form
 * wants — which might be "Yes", "Yes, I am authorized to work", or
 * "I am authorized to work for any employer". Getting this wrong silently
 * submits the opposite of what the candidate said, so anything below the
 * caller's threshold is escalated to a human rather than guessed.
 */
export function matchOption(desired: string, options: FieldOption[]): OptionMatch | null {
  if (!options.length) return null;
  const want = normalizeLabel(desired);
  if (!want) return null;

  // 1. Exact normalised match.
  for (const o of options) {
    if (normalizeLabel(o.label) === want) return { option: o, score: 1 };
    if (o.value && normalizeLabel(o.value) === want) return { option: o, score: 1 };
  }

  // 2. Boolean intent. "true" -> the yes-ish option, and only if exactly one
  //    option is yes-ish (otherwise the mapping is genuinely ambiguous).
  const wantsYes = AFFIRMATIVE.has(want);
  const wantsNo = NEGATIVE.has(want);
  if (wantsYes || wantsNo) {
    const pool = options.filter((o) => {
      const n = normalizeLabel(o.label);
      return wantsYes ? isAffirmative(n) : isNegative(n);
    });
    if (pool.length === 1) return { option: pool[0]!, score: 0.95 };
    // Two-option controls are unambiguous even when the labels are verbose.
    if (options.length === 2) {
      const yesIdx = options.findIndex((o) => isAffirmative(normalizeLabel(o.label)));
      const noIdx = options.findIndex((o) => isNegative(normalizeLabel(o.label)));
      if (yesIdx >= 0 && noIdx >= 0) {
        return { option: options[wantsYes ? yesIdx : noIdx]!, score: 0.9 };
      }
    }
    return null;
  }

  // 3. Substring containment, but only when exactly one option contains the
  //    other. Multiple partial hits mean we cannot tell them apart.
  const contains = options.filter((o) => {
    const n = normalizeLabel(o.label);
    return n.includes(want) || want.includes(n);
  });
  if (contains.length === 1) return { option: contains[0]!, score: 0.8 };

  // 4. Token overlap (Jaccard) as a last resort.
  const wantTokens = new Set(want.split(' ').filter(Boolean));
  let best: OptionMatch | null = null;
  for (const o of options) {
    const t = new Set(normalizeLabel(o.label).split(' ').filter(Boolean));
    const inter = [...wantTokens].filter((x) => t.has(x)).length;
    const union = new Set([...wantTokens, ...t]).size || 1;
    const score = (inter / union) * 0.75;
    if (score > 0.45 && (!best || score > best.score)) best = { option: o, score };
  }
  return best;
}

function isAffirmative(n: string): boolean {
  return /^(yes|y|true)\b/.test(n) || /\bi am\b/.test(n) || /\bauthori[sz]ed\b/.test(n);
}
function isNegative(n: string): boolean {
  return /^(no|n|false)\b/.test(n) || /\bi am not\b/.test(n) || /\bnot authori[sz]ed\b/.test(n);
}

/** The privacy-preserving default for EEO questions, when the form offers one. */
export function findDeclineOption(options: FieldOption[] | undefined): FieldOption | null {
  if (!options) return null;
  return options.find((o) => DECLINE_PATTERNS.some((p) => p.test(o.label))) ?? null;
}
