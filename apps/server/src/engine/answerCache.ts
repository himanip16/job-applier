import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeLabel, type FormField, type ResolvedAnswer } from '@ja/shared';
import { artifactsDir } from '../lib/config.js';

/**
 * What an earlier attempt at this application already worked out.
 *
 * A run that dies - the tab closed, the server restarted, you stopped it
 * waiting on a question - used to throw away every answer it had derived, so
 * Resume paid for the same essay and the same inferences again, against a
 * rate-limited model, and could come back with different wording. Answers are
 * written here the moment they are resolved, and a restarted run takes them
 * as-is for any field that still asks the same question.
 *
 * Only derived answers are kept. Profile and answer-bank values are free to
 * look up again and may have changed since; your own replies already live on
 * the pending questions.
 */
const CACHED_SOURCES = new Set(['GENERATED', 'INFERRED']);

interface CachedAnswer {
  label: string;
  kind: FormField['kind'];
  value: string | string[];
  displayValue: string;
  source: ResolvedAnswer['source'];
  confidence: number;
  rationale?: string;
}

type Cache = Record<string, CachedAnswer>;

const fileFor = (applicationId: string) => path.join(artifactsDir, applicationId, 'answer-cache.json');
/** Same question, same kind of control. Field handles change between runs; labels do not. */
const keyFor = (field: Pick<FormField, 'label' | 'kind'>) => `${field.kind}:${normalizeLabel(field.label)}`;

export async function readAnswerCache(applicationId: string): Promise<Cache> {
  try {
    return JSON.parse(await fs.readFile(fileFor(applicationId), 'utf8')) as Cache;
  } catch {
    return {};
  }
}

/** Record the derived answers from one form step. Best effort: a failed write costs a re-derive, nothing more. */
export async function saveToAnswerCache(
  applicationId: string,
  fields: FormField[],
  answers: Map<string, ResolvedAnswer>,
): Promise<void> {
  const cache = await readAnswerCache(applicationId);
  let changed = false;
  for (const field of fields) {
    const a = answers.get(field.id);
    if (!a || !CACHED_SOURCES.has(a.source) || a.value === null) continue;
    cache[keyFor(field)] = {
      label: field.label,
      kind: field.kind,
      value: a.value as string | string[],
      displayValue: a.displayValue,
      source: a.source,
      confidence: a.confidence,
      rationale: a.rationale,
    };
    changed = true;
  }
  if (!changed) return;
  try {
    await fs.mkdir(path.dirname(fileFor(applicationId)), { recursive: true });
    await fs.writeFile(fileFor(applicationId), JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* see above */
  }
}

/**
 * Put earlier derived answers in front of the resolver for this step's fields.
 * An option answer is reused only while the form still offers that option.
 */
export function reuseCachedAnswers(
  fields: FormField[],
  cache: Cache,
  sessionAnswers: Map<string, ResolvedAnswer>,
): void {
  for (const field of fields) {
    if (sessionAnswers.has(field.id)) continue;
    const hit = cache[keyFor(field)];
    if (!hit) continue;
    if (field.options?.length) {
      const offered = new Set(field.options.map((o) => normalizeLabel(o.label)));
      const wanted = Array.isArray(hit.value) ? hit.value : [hit.value];
      if (!wanted.every((v) => offered.has(normalizeLabel(v)))) continue;
    }
    sessionAnswers.set(field.id, {
      fieldId: field.id,
      value: hit.value,
      displayValue: hit.displayValue,
      source: hit.source,
      confidence: hit.confidence,
      rationale: `Reused from your earlier attempt. ${hit.rationale ?? ''}`.trim(),
      remember: false,
      canonicalKey: field.canonicalKey,
    });
  }
}
