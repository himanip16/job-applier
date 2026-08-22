import { prisma, type Answer, type Prisma } from '../lib/db.js';
import {
  normalizeLabel,
  vectorize,
  cosine,
  optionsCompatible,
  type SparseVector,
  type FieldOption,
} from '@ja/shared';

export interface BankMatch {
  answer: Answer;
  similarity: number;
  how: 'CANONICAL' | 'EXACT' | 'FUZZY';
}

/**
 * Look up a previously-given answer.
 *
 * Three tiers, strongest first:
 *  1. canonical key - the rule layer already identified this as a known
 *     question, so any stored answer under that key applies regardless of
 *     wording.
 *  2. exact normalised label - the same question, verbatim.
 *  3. fuzzy - lexically similar label above `threshold`.
 *
 * Every tier additionally requires option-set compatibility, so a "Yes" given
 * to a yes/no question is never silently reused on a five-way dropdown.
 */
export async function findAnswer(args: {
  profileId: string;
  canonicalKey?: string;
  label: string;
  options?: FieldOption[];
  companyKey?: string;
  threshold: number;
}): Promise<BankMatch | null> {
  const normalized = normalizeLabel(args.label);

  // Per-company answers only match within the same company.
  const scopeFilter: Prisma.AnswerWhereInput = {
    OR: [{ scope: 'GLOBAL' }, { scope: 'PER_COMPANY', companyKey: args.companyKey ?? ' ' }],
  };

  if (args.canonicalKey) {
    const hits = await prisma.answer.findMany({
      where: { profileId: args.profileId, canonicalKey: args.canonicalKey, ...scopeFilter },
      orderBy: [{ source: 'asc' }, { updatedAt: 'desc' }],
    });
    const usable = hits.find((a) => optionsCompatible(a.options as FieldOption[] | null, args.options));
    if (usable) return { answer: usable, similarity: 1, how: 'CANONICAL' };
  }

  const exact = await prisma.answer.findMany({
    where: { profileId: args.profileId, normalizedLabel: normalized, ...scopeFilter },
    orderBy: [{ updatedAt: 'desc' }],
  });
  const usableExact = exact.find((a) => optionsCompatible(a.options as FieldOption[] | null, args.options));
  if (usableExact) return { answer: usableExact, similarity: 1, how: 'EXACT' };

  // Fuzzy: brute-force cosine over the profile's bank. An individual's bank is
  // a few hundred rows at most, so this needs no vector index or second
  // datastore to stay well under a millisecond.
  const all = await prisma.answer.findMany({
    where: { profileId: args.profileId, ...scopeFilter },
  });
  const target = vectorize(args.label);
  let best: BankMatch | null = null;
  for (const a of all) {
    if (!optionsCompatible(a.options as FieldOption[] | null, args.options)) continue;
    const sim = cosine(target, a.vector as SparseVector);
    if (sim >= args.threshold && (!best || sim > best.similarity)) {
      best = { answer: a, similarity: sim, how: 'FUZZY' };
    }
  }
  return best;
}

/**
 * Write an answer into the bank. USER-sourced answers overwrite anything the
 * machine previously guessed for the same key; machine answers never overwrite
 * a human one.
 */
export async function rememberAnswer(args: {
  profileId: string;
  canonicalKey?: string;
  rawLabel: string;
  value: unknown;
  displayValue: string;
  fieldKind: Answer['fieldKind'];
  options?: FieldOption[];
  source: Answer['source'];
  confidence: number;
  scope?: Answer['scope'];
  companyKey?: string;
}): Promise<Answer> {
  const normalizedLabel = normalizeLabel(args.rawLabel);
  const vector = vectorize(args.rawLabel) as unknown as Prisma.InputJsonValue;

  const scope = args.scope ?? 'GLOBAL';
  // companyKey scopes identity only for PER_COMPANY answers. Including it for
  // GLOBAL ones splits a single answer into one row per employer.
  const companyKey = scope === 'PER_COMPANY' ? (args.companyKey ?? null) : null;

  const existing = await prisma.answer.findFirst({
    where: {
      profileId: args.profileId,
      ...(args.canonicalKey ? { canonicalKey: args.canonicalKey } : { normalizedLabel }),
      scope,
      companyKey,
    },
  });

  if (existing) {
    // A human's answer is the ground truth; never let a later guess clobber it.
    if (existing.source === 'USER' && args.source !== 'USER') return existing;
    return prisma.answer.update({
      where: { id: existing.id },
      data: {
        rawLabel: args.rawLabel,
        normalizedLabel,
        vector,
        value: args.value as Prisma.InputJsonValue,
        displayValue: args.displayValue,
        fieldKind: args.fieldKind,
        options: (args.options ?? undefined) as Prisma.InputJsonValue | undefined,
        source: args.source,
        confidence: args.confidence,
      },
    });
  }

  return prisma.answer.create({
    data: {
      profileId: args.profileId,
      canonicalKey: args.canonicalKey ?? null,
      rawLabel: args.rawLabel,
      normalizedLabel,
      vector,
      value: args.value as Prisma.InputJsonValue,
      displayValue: args.displayValue,
      fieldKind: args.fieldKind,
      options: (args.options ?? undefined) as Prisma.InputJsonValue | undefined,
      source: args.source,
      confidence: args.confidence,
      scope,
      companyKey,
    },
  });
}

export async function noteAnswerUsed(id: string): Promise<void> {
  await prisma.answer.update({
    where: { id },
    data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
  });
}
