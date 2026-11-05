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
 * Workday's My Experience step is the same idea in different markup:
 *
 *   [role=group][aria-labelledby="Work-Experience-section"] > [role=group]*, div > button[add-button]
 *   [role=group][aria-labelledby="Education-section"]       > [role=group]*, div > button[add-button]
 *
 * SmartRecruiters' one-click form has one editor per entry, opened by an
 * "Add" `spl-button` and closed with its own Save, every input inside a
 * shadow root:
 *
 *   oc-experience > [data-test=experience] … oc-experience-entry*, oc-button[data-test=add-experience]
 *   oc-education  > [data-test=education]  … oc-education-entry*,  oc-button[data-test=add-education]
 *
 * Oracle Recruiting Cloud lists saved entries as tiles and opens one inline
 * editor at a time from its "Add Education" / "Add Experience" button; the
 * editor closes with its own Save. Its blocks carry no stable name, so the
 * Oracle adapter tags each container with `data-ja-rows` from the block's
 * title:
 *
 *   [data-ja-rows] … article.apply-flow-profile-item-tile*, .profile-item-content, button.apply-flow-profile-item-tile__new-tile
 *
 * With one editor at a time, a pass adds a single entry: enough for a
 * required block, and the rest are on the resume.
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
  employment: {
    container:
      '.employment--container, [role="group"][aria-labelledby="Work-Experience-section"], oc-experience > [data-test="experience"], ' +
      '[data-ja-rows="employment"]',
    title: 'Employment',
  },
  education: {
    container:
      '.education--container, [role="group"][aria-labelledby="Education-section"], oc-education > [data-test="education"], ' +
      '[data-ja-rows="education"]',
    title: 'Education',
  },
};

/**
 * Greenhouse's trailing button, Workday's inside its own wrapper (which holds
 * no input), SmartRecruiters' "Add" web component, or Oracle's "Add ..."
 * button (disabled while its editor is open).
 */
const ADD_ANOTHER =
  ':scope > button.add-another-button, :scope > :not(:has(input)) button[data-automation-id="add-button"], ' +
  'oc-button[data-test^="add-"] spl-button, button.apply-flow-profile-item-tile__new-tile:not(:disabled)';

/**
 * Rows that are their own element, wherever they sit in the container.
 * Without one, a row is a direct child holding an input (Greenhouse, Workday);
 * SmartRecruiters' inputs are all in shadow roots, so that test sees none.
 * Oracle's saved tiles hold no input at all, and its open editor is a row too.
 */
const ROW = 'oc-experience-entry, oc-education-entry, article.apply-flow-profile-item-tile, .profile-item-content';

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
      // An adapter tags a button that sits outside the rows' own container
      // (TurboHire's Education "Add New Entry") with `data-ja-add`.
      const add = container.locator(ADD_ANOTHER).or(page.locator(`[data-ja-add="${kind}"]`)).first();
      if (!(await add.count()) || !(await add.isVisible())) break;
      await add.scrollIntoViewIfNeeded().catch(() => {});
      await add.click();
      // The new row renders synchronously in practice; wait for it rather
      // than assume, and stop if it never comes so this cannot loop forever.
      const was = now;
      for (let waited = 0; now <= was && waited < 3000; waited += 150) {
        await page.waitForTimeout(150);
        now = await rows();
      }
      if (now <= was) break;
    }
    report.push({ kind, before, after: now, wanted });
  }
  return report;
}

async function countRows(page: Page, containerSelector: string): Promise<number> {
  return page.evaluate(
    ({ sel, rowSel }) => {
      const c = document.querySelector(sel);
      if (!c) return 0;
      return c.querySelector(rowSel)
        ? c.querySelectorAll(rowSel).length
        : Array.from(c.children).filter((el) => el.querySelector('input')).length;
    },
    { sel: containerSelector, rowSel: ROW },
  );
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
    ({ selectors, sections, rowSel }) => {
      // Through open shadow roots, both down to the field and back up from
      // it: SmartRecruiters' inputs live inside `spl-*` components.
      const find = (sel: string): Element | null => {
        const visit = (node: ParentNode): Element | null => {
          const hit = node.querySelector(sel);
          if (hit) return hit;
          for (const el of Array.from(node.querySelectorAll('*'))) {
            const inner = el.shadowRoot && visit(el.shadowRoot);
            if (inner) return inner;
          }
          return null;
        };
        return visit(document);
      };
      const up = (el: Element): Element | null =>
        el.parentElement ?? ((el.getRootNode() as ShadowRoot).host || null);
      const closest = (el: Element, sel: string) => {
        for (let e: Element | null = el; e; e = up(e)) if (e.matches(sel)) return e;
        return null;
      };
      const within = (el: Element, row: Element) => {
        for (let e: Element | null = el; e; e = up(e)) if (e === row) return true;
        return false;
      };

      return selectors.map((selector) => {
        const el = find(selector);
        if (!el) return null;
        for (const [kind, containerSel] of sections) {
          const container = closest(el, containerSel);
          if (!container) continue;
          const rows = container.querySelector(rowSel)
            ? Array.from(container.querySelectorAll(rowSel))
            : Array.from(container.children).filter((c) => c.querySelector('input'));
          const index = rows.findIndex((row) => within(el, row));
          if (index < 0) continue;
          // What the site already shows in this row (TurboHire pre-fills
          // the jobs it parsed from the resume), to tell which entry it is.
          const values = Array.from(rows[index]!.querySelectorAll<HTMLInputElement>('input, textarea'))
            .map((i) => i.value.trim())
            .filter(Boolean);
          return { kind, index, rows: rows.length, values };
        }
        return null;
      });
    },
    {
      selectors: fields.map((f) => f.selector),
      sections: (Object.keys(SECTIONS) as SectionKind[]).map((k) => [k, SECTIONS[k].container] as const),
      rowSel: ROW,
    },
  );

  const entryOf = assignEntries(where, history);

  return fields.map((field, i) => {
    const at = where[i];
    if (!at) return field;
    const kind = at.kind as SectionKind;
    const slot = entryOf.get(`${kind}:${at.index}`) ?? at.index;
    if (slot < 0) {
      return {
        ...field,
        label: `${SECTIONS[kind].title} (extra row): ${field.label}`,
        helpText: [
          `This ${SECTIONS[kind].title} row matches none of the entries on record (they are all in other rows); leave it blank.`,
          field.helpText,
        ]
          .filter(Boolean)
          .join(' '),
        canonicalKey: undefined,
      };
    }
    const n = slot + 1;
    const label = `${SECTIONS[kind].title} ${n}: ${field.label}`;

    const entry = history?.[kind][slot];
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

/**
 * Which entry on record each row is for, as "kind:rowIndex" -> entry index
 * (-1: none left). A row the site already filled belongs to the entry whose
 * company or school it shows - TurboHire lists the jobs it parsed, a blank
 * junk row among them, so going by position put the wrong job in every row
 * after it. The other rows take the unclaimed entries in order. Without a
 * history, row n is entry n.
 */
function assignEntries(
  where: ({ kind: string; index: number; values: string[] } | null)[],
  history: ResumeHistory | null,
): Map<string, number> {
  const out = new Map<string, number>();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const kind of Object.keys(SECTIONS) as SectionKind[]) {
    const names = (history?.[kind] ?? []).map((e) => norm('company' in e ? e.company : e.school));
    if (!names.length) continue;
    const rows = new Map<number, string[]>();
    for (const at of where) {
      if (at?.kind === kind) rows.set(at.index, [...(rows.get(at.index) ?? []), ...at.values.map(norm)]);
    }
    const order = [...rows.keys()].sort((a, b) => a - b);
    const claimed = new Set<number>();
    for (const r of order) {
      const shown = rows.get(r)!.filter((v) => v.length >= 3);
      const hit = names.findIndex(
        (name, j) => !!name && !claimed.has(j) && shown.some((v) => v.includes(name) || name.includes(v)),
      );
      if (hit >= 0) {
        out.set(`${kind}:${r}`, hit);
        claimed.add(hit);
      }
    }
    for (const r of order) {
      if (out.has(`${kind}:${r}`)) continue;
      const next = names.findIndex((_, j) => !claimed.has(j));
      out.set(`${kind}:${r}`, next);
      if (next >= 0) claimed.add(next);
    }
  }
  return out;
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

/** "Oct 2025" or "10/2025" -> "10/2025"; null unless both month and year are stated. */
function slashMonthYear(date: string): string | null {
  const numeric = /\b(0?[1-9]|1[0-2])\/((?:19|20)\d{2})\b/.exec(date);
  if (numeric) return `${numeric[1]!.padStart(2, '0')}/${numeric[2]}`;
  const name = monthOf(date);
  const year = yearOf(date);
  return name && year ? `${String(MONTHS.indexOf(name) + 1).padStart(2, '0')}/${year}` : null;
}

/**
 * Set by an adapter whose date box parses only one shape. SmartRecruiters'
 * month-year picker reads "10/2023" correctly and "Mar 2025" as August 2027.
 */
export const MONTH_YEAR_HINT = 'Type the date as MM/YYYY, e.g. 10/2023.';

/**
 * Set by an adapter whose date box takes a full day-month-year date, with the
 * separator it uses (TurboHire: "DD/MM/YYYY", "DD-MM-YYYY").
 */
export const dayMonthYearHint = (sep: '/' | '-') => `Type the date as DD${sep}MM${sep}YYYY.`;

/**
 * "Oct 2025" -> "01/10/2025" for a box that wants a day. The saved record has
 * no day, so it is the 1st; null unless the month and year are both stated.
 */
function dayMonthYear(date: string, sep: string): string | null {
  const my = slashMonthYear(date);
  return my ? `01${sep}${my.replace('/', sep)}` : null;
}

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
  field: Pick<FormField, 'label' | 'kind' | 'helpText'>,
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
  // Workday's date boxes are typed digits ("10"), not a month dropdown.
  const month = (date: string) => {
    const name = monthOf(date);
    if (!name || field.kind === 'SELECT') return name;
    return String(MONTHS.indexOf(name) + 1).padStart(2, '0');
  };
  const slashed = field.helpText?.includes(MONTH_YEAR_HINT) ?? false;
  const dmy = /Type the date as DD([/-])MM\1YYYY\./.exec(field.helpText ?? '')?.[1];
  if (/\b(start|from)\b/.test(q)) {
    if (dmy) return dayMonthYear(start, dmy);
    if (slashed) return slashMonthYear(start);
    if (/month/.test(q)) return month(start);
    if (/year/.test(q)) return yearOf(start);
    return start || null;
  }
  // TurboHire's education row asks "Passed on".
  if (/\b(end|to|until)\b|passed|graduat|complet/.test(q)) {
    if (isOngoing(end)) return '';
    if (dmy) return dayMonthYear(end, dmy);
    if (slashed) return slashMonthYear(end);
    if (/month/.test(q)) return month(end);
    if (/year/.test(q)) return yearOf(end);
    return end;
  }
  const pick = (v: string | undefined) => v || null;
  if (/company|employer|organi[sz]ation/.test(q)) return pick(entry.company);
  // TurboHire asks for the Institute and, separately, the University it is
  // affiliated to; the adapter names the second "Affiliating university".
  if (/affiliat/.test(q)) return pick(entry.university);
  if (/school|university|college|institut/.test(q)) return pick(entry.school);
  if (/discipline|major|field of study|specialization/.test(q)) return pick(entry.discipline);
  if (/degree|qualification/.test(q)) return pick(entry.degree);
  if (/gpa|grade/.test(q)) return pick(entry.cgpa ?? entry.gpa);
  if (/location|city/.test(q)) return pick(entry.location);
  // Workday's "Role Description": a write-up, not the title the rule below would give.
  if (/description|responsibilit|summary|achievement/.test(q)) return null;
  if (/title|position|role/.test(q)) return pick(entry.title);
  return null;
}

const DEGREE_RANK = ['High School', "Associate's Degree", "Bachelor's Degree", "Master's Degree",
  'Master of Business Administration (M.B.A.)', 'Doctor of Philosophy (Ph.D.)'];

/**
 * One-off questions about the candidate's history, outside any Employment /
 * Education row: "Highest Degree", "Graduation/Post-Graduation College",
 * "Current company of the candidate" (Oolka, October 2026). Answered from the
 * same employment.N / education.N facts; null when they do not say.
 */
export function answerFromSavedHistory(
  field: Pick<FormField, 'label' | 'kind'>,
  facts: { key: string; value: string }[],
): string | null {
  if (/^(Employment|Education) \d+: /.test(field.label)) return null;
  const q = field.label.toLowerCase().trim();
  // "Did you attend school in the US?" wants a yes or no, not the school.
  if (/^(did|do|does|are|is|have|has|were|was|will|can|would)\b/.test(q)) return null;
  const parse = (value: string) =>
    Object.fromEntries(
      value.split('|').flatMap((part) => {
        const i = part.indexOf(':');
        return i < 0 ? [] : [[part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()]];
      }),
    ) as Record<string, string | undefined>;
  const numbered = (prefix: string) =>
    facts
      .map((f) => ({ n: Number(new RegExp(`^${prefix}\\.(\\d+)$`).exec(f.key)?.[1]), f }))
      .filter((x) => Number.isFinite(x.n))
      .sort((a, b) => a.n - b.n)
      .map((x) => parse(x.f.value));

  if (/\bcurrent(ly)?\b.*\b(company|employer|organi[sz]ation)\b|\b(company|employer)\b.*\bcurrent(ly)?\b/.test(q)) {
    const latest = numbered('employment')[0];
    if (!latest?.company) return null;
    const current = latest.current ? /^(yes|true)$/i.test(latest.current) : isOngoing(latest.end);
    return current ? latest.company : null;
  }

  const education = numbered('education');
  if (!education.length) return null;
  // The highest degree on record; ties go to the most recent (listed first).
  const rank = (e: Record<string, string | undefined>) => DEGREE_RANK.indexOf(degreeLevel(e.degree ?? '') ?? '');
  const top = education.reduce((best, e) => (rank(e) > rank(best) ? e : best), education[0]!);

  if (/\b(year|date|when|grade|gpa|cgpa|percent|score|marks|branch|major|discipline|speciali[sz]ation|stream)\b/.test(q)) {
    return null;
  }
  if (/\bhighest\b.*\b(degree|qualification|education)\b|^(degree|qualification|education(al)? qualification)\b/.test(q)) {
    return top.degree || null;
  }
  if (/\b(college|university|institut(e|ion)|alma mater|school)\b/.test(q)) {
    return top.school || null;
  }
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
