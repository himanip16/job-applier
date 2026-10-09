import type { Page } from 'playwright';
import { getCanonical, normalizeLabel, type FormField, type ResolvedAnswer } from '@ja/shared';
import { bus } from '../lib/events.js';
import { readShown } from '../browser/fill.js';
import { rememberAnswer } from './answerBank.js';
import type { FieldPlanEntry } from './fieldPlan.js';
import { truncate } from './runLog.js';

/**
 * Answers you change by typing in the open browser tab.
 *
 * After the run fills a step it notes what each control shows. Whenever it is
 * about to leave the step - pressing Next, submitting - and every few seconds
 * while it waits on you, it looks again: a control that now shows something
 * else is your edit. Your value replaces the run's answer for this
 * application, and goes into your answer bank straight away, so the next form
 * that asks the same question gets your wording instead of the old one.
 *
 * Saved at once rather than after a confirmed submit (unlike the run's own
 * answers): a value a person typed is not a guess that could poison the bank,
 * and waiting would lose it whenever the application is never sent.
 *
 * Profile answers - your name, email, phone - are only overridden here, not
 * saved: the profile is read before the bank, so a banked copy would never be
 * used. Change those in your profile.
 */

const POLL_MS = 2_000;

/** Your edits that must not reach the bank at submit time either. */
export const thisApplicationOnly = new WeakSet<ResolvedAnswer>();

interface Watched {
  field: FormField;
  shown: string[];
}

export class BrowserEdits {
  private watched = new Map<string, Watched>();
  private answers = new Map<string, ResolvedAnswer>();
  private sessionAnswers = new Map<string, ResolvedAnswer>();
  private plan: FieldPlanEntry[] = [];
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly o: { applicationId: string; page: Page; profileId: string; companyKey: string },
  ) {}

  /** The run's own records, which an edit updates in place. */
  attach(refs: {
    answers: Map<string, ResolvedAnswer>;
    sessionAnswers: Map<string, ResolvedAnswer>;
    plan: FieldPlanEntry[];
  }): void {
    this.answers = refs.answers;
    this.sessionAnswers = refs.sessionAnswers;
    this.plan = refs.plan;
  }

  /** The run has just filled these; what they show now is the run's doing. */
  async baseline(fields: FormField[]): Promise<void> {
    await this.serial(async () => {
      this.watched.clear();
      for (const field of fields) {
        if (field.kind === 'FILE') continue;
        const shown = await readShown(this.o.page, field);
        if (shown) this.watched.set(field.id, { field, shown });
      }
    });
  }

  /**
   * Stop watching. Called as soon as the page moves to another step, because
   * handles are re-stamped per step: the old step's "f3" would otherwise be
   * read off the new step's third control and look like an edit.
   */
  forget(): void {
    this.watched.clear();
  }

  /** Look once for controls you changed, and take those as your answers. */
  capture(): Promise<void> {
    return this.serial(async () => {
      const { page } = this.o;
      if (page.isClosed()) return;
      for (const [id, w] of this.watched) {
        const now = await readShown(page, w.field);
        // Gone or blank is not an answer: the page moved on, or a dependent
        // control was reset by another choice.
        if (!now?.length || same(now, w.shown)) continue;
        w.shown = now;
        const prior = this.answers.get(id);
        if (prior && holds(now, prior.value, w.field)) continue;
        await this.adopt(w.field, now, prior);
      }
    });
  }

  /** Keep looking while waiting on you, and once more when the wait ends. */
  async during<T>(wait: Promise<T>): Promise<T> {
    let done = false;
    const loop = (async () => {
      while (!done && !this.o.page.isClosed()) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!done) await this.capture().catch(() => {});
      }
    })();
    try {
      return await wait;
    } finally {
      done = true;
      await loop;
      await this.capture().catch(() => {});
    }
  }

  /** A tab left open for you: keep watching until it closes. */
  watchUntilClosed(): void {
    void this.during(new Promise<void>((resolve) => this.o.page.once('close', () => resolve()))).catch(() => {});
  }

  private async adopt(field: FormField, shown: string[], prior: ResolvedAnswer | undefined): Promise<void> {
    const { applicationId, profileId, companyKey } = this.o;
    const many = field.kind === 'MULTISELECT' || field.kind === 'CHECKBOX_GROUP';
    const value = many ? shown : shown.join(', ');
    const displayValue = shown.join(', ');
    const fromProfile = prior?.source === 'PROFILE' || prior?.source === 'RULE';
    const sensitive = field.sensitive || Boolean(field.canonicalKey && getCanonical(field.canonicalKey)?.sensitive);
    const answer: ResolvedAnswer = {
      fieldId: field.id,
      value,
      displayValue,
      source: 'USER',
      confidence: 1,
      rationale: 'You changed this in the browser.',
      remember: !fromProfile && !sensitive,
      canonicalKey: field.canonicalKey,
    };
    if (!answer.remember) thisApplicationOnly.add(answer);
    this.answers.set(field.id, answer);
    this.sessionAnswers.set(field.id, answer);

    const last = [...this.plan].reverse().find((p) => p.fieldId === field.id);
    const row = {
      value, source: 'USER', confidence: 1, rationale: answer.rationale,
      filled: true, verified: displayValue, error: undefined,
    };
    if (last) Object.assign(last, row);
    else this.plan.push({ fieldId: field.id, label: field.label, kind: field.kind, required: field.required, ...row });

    if (!answer.remember) {
      await bus.emitEvent(
        applicationId,
        'LOG',
        `Using what you typed for "${field.label}": ${truncate(displayValue)}. ` +
          (fromProfile
            ? 'It comes from your profile, so update it there to use it everywhere.'
            : 'Demographic answers are not saved to your answer bank.'),
      );
      return;
    }
    // An answer written for this company - an essay, "why us" - stays with it.
    const perCompany =
      prior?.source === 'GENERATED' ||
      Boolean(field.canonicalKey && getCanonical(field.canonicalKey)?.perCompany);
    await rememberAnswer({
      profileId,
      canonicalKey: field.canonicalKey,
      rawLabel: field.label,
      value,
      displayValue,
      fieldKind: field.kind,
      options: field.options,
      source: 'USER',
      confidence: 1,
      scope: perCompany ? 'PER_COMPANY' : 'GLOBAL',
      companyKey,
    });
    await bus.emitEvent(
      applicationId,
      'MEMORY_WRITTEN',
      `You changed "${field.label}" in the browser to ${truncate(displayValue)} - saved to your answer bank.`,
      { fieldId: field.id, manual: true },
    );
  }

  /** Reads and edits one at a time; a poll must not overlap a capture. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const turn = this.running.then(fn);
    this.running = turn.catch(() => {});
    return turn;
  }
}

function same(a: string[], b: string[]): boolean {
  return a.map(normalizeLabel).join('|') === b.map(normalizeLabel).join('|');
}

/** The control shows what the run meant to put there, give or take formatting. */
function holds(shown: string[], wanted: ResolvedAnswer['value'], field: FormField): boolean {
  if (wanted === null || typeof wanted === 'boolean' || typeof wanted === 'number') return false;
  const want = (Array.isArray(wanted) ? wanted : [wanted]).map(normalizeLabel).filter(Boolean);
  const got = shown.map(normalizeLabel);
  if (field.kind === 'PHONE') {
    const digits = (v: string) => v.replace(/\D/g, '');
    return want.every((w) => digits(got.join('')).endsWith(digits(w)));
  }
  return want.length === got.length && want.every((w) => got.includes(w));
}
