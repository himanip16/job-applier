import { z } from 'zod';
import type { Page } from 'playwright';
import type { FormField } from '@ja/shared';
import { generate } from '../llm/client.js';

/**
 * Employment and Education blocks that grow with an "Add another" button.
 *
 * Greenhouse's new boards render one row per entry inside a container and a
 * trailing `button.add-another-button`:
 *
 *   .employment--container > .employment-form*, button.add-another-button
 *   .education--container  > .education--form*,  button.add-another-button
 *
 * Every row reuses the same labels ("Company name", "Title", ...), so without
 * help the model sees three identical questions and fills the most recent
 * role into all of them. Two things fix that: add rows until there is one per
 * entry on the resume, and name each row's fields after the entry it is for.
 *
 * The number of rows comes only from the resume. An entry the resume does not
 * list is never invented, and a form that already has more rows than that is
 * left alone.
 */

export type SectionKind = 'employment' | 'education';

const SECTIONS: Record<SectionKind, { container: string; title: string }> = {
  employment: { container: '.employment--container', title: 'Employment' },
  education: { container: '.education--container', title: 'Education' },
};

/** More than this is a runaway loop, not a career. */
const MAX_ROWS = 10;

// ------------------------------------------------------------------ resume

const HistorySchema = z.object({
  employment: z
    .array(
      z.object({
        company: z.string(),
        title: z.string(),
        dates: z.string().describe('Dates exactly as the resume writes them, or empty.'),
      }),
    )
    .describe('Every job on the resume, most recent first. Only entries the resume actually lists.'),
  education: z
    .array(
      z.object({
        school: z.string(),
        degree: z.string().describe('Degree and discipline as written, or empty.'),
        dates: z.string().describe('Dates exactly as the resume writes them, or empty.'),
      }),
    )
    .describe('Every school or degree on the resume, most recent first. Only entries the resume actually lists.'),
});

export type ResumeHistory = z.infer<typeof HistorySchema>;

const SYSTEM = `You list the jobs and education entries stated in a candidate's resume.
Copy names, titles and dates as written. Never add an entry the resume does not contain, and never fill in a value it does not state - use an empty string.`;

/**
 * The candidate's own record, when they have saved one as profile facts:
 * `employment.1`, `employment.2`, ... and `education.1`, ..., each a line of
 * "Field: value | Field: value". Numbered most recent first.
 */
export function historyFromFacts(facts: { key: string; value: string }[]): ResumeHistory | null {
  const parse = (value: string) =>
    Object.fromEntries(
      value.split('|').map((part) => {
        const i = part.indexOf(':');
        return i < 0 ? ['', ''] : [part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()];
      }),
    ) as Record<string, string | undefined>;
  const numbered = (prefix: string) =>
    facts
      .map((f) => ({ n: Number(new RegExp(`^${prefix}\\.(\\d+)$`).exec(f.key)?.[1]), f }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n)
      .map((x) => parse(x.f.value));
  const dates = (e: Record<string, string | undefined>) =>
    [e.start ?? e['start year'], e.end ?? e['end year']].filter(Boolean).join(' – ');

  const employment = numbered('employment').map((e) => ({
    company: e.company ?? '',
    title: e.title ?? '',
    dates: dates(e),
  }));
  const education = numbered('education').map((e) => ({
    school: e.school ?? '',
    degree: e.degree ?? '',
    dates: dates(e),
  }));
  return employment.length || education.length ? { employment, education } : null;
}

/** Null when the model is unavailable; callers then leave the form as it is. */
export async function readResumeHistory(candidateContext: string): Promise<ResumeHistory | null> {
  return generate({
    task: 'answerInference',
    system: SYSTEM,
    prompt: `${candidateContext}\n\nList the employment and education entries in the resume above.`,
    schema: HistorySchema,
    maxTokens: 1500,
  });
}

// -------------------------------------------------------------------- page

/** Whether this screen has anything to expand, so the resume is read only when it matters. */
export async function hasRepeatableSections(page: Page): Promise<boolean> {
  const selector = Object.values(SECTIONS).map((s) => s.container).join(', ');
  return (await page.locator(selector).count().catch(() => 0)) > 0;
}

/**
 * Click "Add another" until each section has one row per resume entry.
 * Returns how many rows each section ended with, for the log.
 */
export async function expandRepeatableSections(
  page: Page,
  history: ResumeHistory,
): Promise<{ kind: SectionKind; before: number; after: number; wanted: number }[]> {
  const report: { kind: SectionKind; before: number; after: number; wanted: number }[] = [];

  for (const kind of Object.keys(SECTIONS) as SectionKind[]) {
    const wanted = Math.min(history[kind].length, MAX_ROWS);
    const container = page.locator(SECTIONS[kind].container).first();
    if (!wanted || !(await container.count())) continue;

    const rows = () => countRows(page, SECTIONS[kind].container);
    const before = await rows();
    let now = before;
    while (now < wanted) {
      const add = container.locator(':scope > button.add-another-button').first();
      if (!(await add.count()) || !(await add.isVisible())) break;
      await add.scrollIntoViewIfNeeded().catch(() => {});
      await add.click();
      // The new row renders synchronously in practice; wait for it rather
      // than assume, and stop if it never comes so this cannot loop forever.
      const grew = await page
        .waitForFunction(
          ({ sel, n }) => {
            const c = document.querySelector(sel);
            return !!c && Array.from(c.children).filter((el) => el.querySelector('input')).length > n;
          },
          { sel: SECTIONS[kind].container, n: now },
          { timeout: 3000 },
        )
        .then(() => true, () => false);
      if (!grew) break;
      now = await rows();
    }
    report.push({ kind, before, after: now, wanted });
  }
  return report;
}

async function countRows(page: Page, containerSelector: string): Promise<number> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel);
    return c ? Array.from(c.children).filter((el) => el.querySelector('input')).length : 0;
  }, containerSelector);
}

/**
 * Name each repeated field after its row: "Employment 2: Company name", with
 * the resume entry that row is for in the help text. Fields outside these
 * sections come back unchanged.
 */
export async function labelRepeatableFields(
  page: Page,
  fields: FormField[],
  history: ResumeHistory | null,
): Promise<FormField[]> {
  const where = await page.evaluate(
    ({ selectors, sections }) =>
      selectors.map((selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        for (const [kind, containerSel] of sections) {
          const container = el.closest(containerSel);
          if (!container) continue;
          const rows = Array.from(container.children).filter((c) => c.querySelector('input'));
          const index = rows.findIndex((row) => row.contains(el));
          if (index >= 0) return { kind, index, rows: rows.length };
        }
        return null;
      }),
    {
      selectors: fields.map((f) => f.selector),
      sections: (Object.keys(SECTIONS) as SectionKind[]).map((k) => [k, SECTIONS[k].container] as const),
    },
  );

  return fields.map((field, i) => {
    const at = where[i];
    if (!at) return field;
    const kind = at.kind as SectionKind;
    const n = at.index + 1;
    const label = `${SECTIONS[kind].title} ${n}: ${field.label}`;

    const entry = history?.[kind][at.index];
    const describe = entry
      ? kind === 'employment'
        ? `This row is for the resume's employment entry #${n}: ${[
            (entry as ResumeHistory['employment'][number]).title,
            (entry as ResumeHistory['employment'][number]).company,
            entry.dates,
          ]
            .filter(Boolean)
            .join(', ')}.`
        : `This row is for the resume's education entry #${n}: ${[
            (entry as ResumeHistory['education'][number]).degree,
            (entry as ResumeHistory['education'][number]).school,
            entry.dates,
          ]
            .filter(Boolean)
            .join(', ')}.`
      : `This is row ${n} of ${at.rows} in the ${SECTIONS[kind].title} section; answer only about the resume's entry #${n} (most recent first).`;

    return {
      ...field,
      label,
      helpText: [describe, field.helpText].filter(Boolean).join(' '),
      // "Company name" in row 2 is not the candidate's current company, so a
      // canonical match on the bare label would give the wrong answer.
      canonicalKey: undefined,
    };
  });
}

// ----------------------------------------------------------------- answers

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Oct 2025" -> October; "2021" -> null. Only what the date actually says. */
function monthOf(date: string): string | null {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(date);
  return m ? MONTHS.find((name) => name.toLowerCase().startsWith(m[1]!.toLowerCase()))! : null;
}
const yearOf = (date: string) => /\b(19|20)\d{2}\b/.exec(date)?.[0] ?? null;
const isOngoing = (end: string | undefined) => !end || /present|current|now|ongoing/i.test(end);

/**
 * Answer a row field ("Employment 2: Start date month") from the candidate's
 * saved `employment.N` / `education.N` facts, with no model involved.
 *
 * Null when the fact does not hold that value - Discipline when only the
 * degree was saved, a month when only a year was - so the field falls
 * through to the ordinary path instead of being guessed. An empty string
 * means "deliberately blank": the end date of a role still held.
 */
export function answerFromHistory(
  field: Pick<FormField, 'label' | 'kind'>,
  facts: { key: string; value: string }[],
): string | boolean | null {
  const at = /^(Employment|Education) (\d+): (.+)$/.exec(field.label);
  if (!at) return null;
  const kind = at[1]!.toLowerCase();
  const fact = facts.find((f) => f.key === `${kind}.${at[2]}`);
  if (!fact) return null;
  const entry = Object.fromEntries(
    fact.value.split('|').flatMap((part) => {
      const i = part.indexOf(':');
      return i < 0 ? [] : [[part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()]];
    }),
  ) as Record<string, string | undefined>;
  const q = at[3]!.toLowerCase();
  const start = entry.start ?? '';
  const end = entry.end ?? '';

  if (field.kind === 'CHECKBOX' || field.kind === 'CHECKBOX_GROUP') {
    // "Current role" must not fall through to the title rule below.
    if (!/current/.test(q)) return null;
    return entry.current ? /^(yes|true)$/i.test(entry.current) : isOngoing(end);
  }
  if (/\b(start|from)\b/.test(q)) {
    if (/month/.test(q)) return monthOf(start);
    if (/year/.test(q)) return yearOf(start);
    return start || null;
  }
  if (/\b(end|to|until)\b/.test(q)) {
    if (isOngoing(end)) return '';
    if (/month/.test(q)) return monthOf(end);
    if (/year/.test(q)) return yearOf(end);
    return end;
  }
  const pick = (v: string | undefined) => v || null;
  if (/company|employer|organi[sz]ation/.test(q)) return pick(entry.company);
  if (/school|university|college|institution/.test(q)) return pick(entry.school);
  if (/discipline|major|field of study|specialization/.test(q)) return pick(entry.discipline);
  if (/degree|qualification/.test(q)) return pick(entry.degree);
  if (/gpa|grade/.test(q)) return pick(entry.cgpa ?? entry.gpa);
  if (/location|city/.test(q)) return pick(entry.location);
  if (/title|position|role/.test(q)) return pick(entry.title);
  return null;
}

/**
 * The degree level a dropdown lists, from the degree as the candidate wrote
 * it: "Bachelor of Technology" or "B.Tech" is a "Bachelor's Degree". This is
 * a renaming, not a guess - null when the wording does not say the level.
 */
export function degreeLevel(degree: string): string | null {
  const d = degree.toLowerCase().replace(/\./g, '');
  if (/\b(phd|dphil|doctorate|doctor of philosophy)\b/.test(d)) return "Doctor of Philosophy (Ph.D.)";
  if (/\bmba\b|master of business administration/.test(d)) return 'Master of Business Administration (M.B.A.)';
  if (/\bmaster|\b(ms|msc|ma|mtech|me|mca|meng)\b/.test(d)) return "Master's Degree";
  if (/\bbachelor|\b(bs|bsc|ba|btech|be|bca|beng|bba|bcom)\b/.test(d)) return "Bachelor's Degree";
  if (/\bassociate/.test(d)) return "Associate's Degree";
  if (/high school|secondary|\bged\b/.test(d)) return 'High School';
  return null;
}
