'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../../components/Icon';
import s from './profile.module.css';

interface Fact { id: string; key: string; label: string; value: string }

/**
 * Jobs and schools, stored as profile facts `employment.1`, `education.1`, ...
 * (most recent first), each a line of "Field: value | Field: value". That is
 * the shape the engine's `historyFromFacts` reads, so the forms' "Add another"
 * sections are filled from here.
 */
type Kind = 'employment' | 'education';
type Entry = Record<string, string>;

const SECTIONS: Record<Kind, { title: string; one: string; fields: [string, string][] }> = {
  employment: {
    title: 'Experience',
    one: 'job',
    fields: [['Company', 'Deliveroo'], ['Title', 'Software Engineer'], ['Location', 'Bangalore'], ['Start', 'Oct 2025'], ['End', 'Feb 2026']],
  },
  education: {
    title: 'Education',
    one: 'school',
    fields: [['School', ''], ['Degree', 'Bachelor of Technology'], ['Discipline', 'e.g. Computer Science'], ['Location', ''], ['Start', '2017'], ['End', '2021'], ['CGPA', '']],
  },
};

const KINDS = Object.keys(SECTIONS) as Kind[];

function parse(value: string): Entry {
  const entry: Entry = {};
  for (const part of value.split('|')) {
    const i = part.indexOf(':');
    if (i > 0) entry[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return entry;
}

/** Blank fields are left out, never written as empty. */
const serialise = (e: Entry) =>
  Object.entries(e)
    .map(([k, v]) => [k, v.replace(/\|/g, '/').trim()])
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');

function fromFacts(facts: Fact[], kind: Kind): Entry[] {
  return facts
    .map((f) => ({ n: Number(new RegExp(`^${kind}\\.(\\d+)$`).exec(f.key)?.[1]), f }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n)
    .map((x) => parse(x.f.value));
}

export function History({ facts, onError }: { facts: Fact[]; onError: (msg: string) => void }) {
  const [entries, setEntries] = useState<Record<Kind, Entry[]>>(() => ({
    employment: fromFacts(facts, 'employment'),
    education: fromFacts(facts, 'education'),
  }));
  const [saved, setSaved] = useState<Record<Kind, number>>(() => ({
    employment: fromFacts(facts, 'employment').length,
    education: fromFacts(facts, 'education').length,
  }));
  const [status, setStatus] = useState<string | null>(null);
  // Fact ids by key, so a removed entry's trailing key can be deleted.
  const ids = useRef(new Map(facts.map((f) => [f.key, f.id])));

  useEffect(() => {
    ids.current = new Map(facts.map((f) => [f.key, f.id]));
  }, [facts]);

  /** Rewrite the whole list, so numbering stays 1..n after a removal. */
  async function persist(kind: Kind, list: Entry[]) {
    setStatus('Saving…');
    try {
      const kept = list.filter((e) => serialise(e));
      for (const [i, e] of kept.entries()) {
        const key = `${kind}.${i + 1}`;
        const { fact } = await api<{ fact: Fact }>('/api/facts', {
          method: 'POST',
          body: JSON.stringify({ key, label: `${SECTIONS[kind].title} ${i + 1}`, value: serialise(e), kind: 'TEXT' }),
        });
        ids.current.set(key, fact.id);
      }
      for (let n = kept.length + 1; n <= saved[kind]; n++) {
        const id = ids.current.get(`${kind}.${n}`);
        if (id) await api(`/api/facts/${id}`, { method: 'DELETE' });
        ids.current.delete(`${kind}.${n}`);
      }
      setSaved((s) => ({ ...s, [kind]: kept.length }));
      setStatus('Saved');
    } catch (e) {
      setStatus(null);
      onError((e as Error).message);
    }
  }

  const update = (kind: Kind, i: number, field: string, value: string) =>
    setEntries((all) => ({ ...all, [kind]: all[kind].map((e, j) => (j === i ? { ...e, [field]: value } : e)) }));

  function remove(kind: Kind, i: number) {
    const list = entries[kind].filter((_, j) => j !== i);
    setEntries((all) => ({ ...all, [kind]: list }));
    void persist(kind, list);
  }

  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <div className={s.sectionTitle}>
          <span className={s.sectionIcon}><Icon name="building" size={18} /></span>
          <div>
            <h2>Experience &amp; education</h2>
            <p>Most recent first. Fills the Employment and Education rows on application forms. Leave a box blank when you don&apos;t know it; nothing is guessed.</p>
          </div>
        </div>
        {status && <span className={s.fileMeta} role="status">{status}</span>}
      </div>

      <div className={s.groups}>
        {KINDS.map((kind) => (
          <div className={s.group} key={kind}>
            <div className={s.groupTitle}>{SECTIONS[kind].title}</div>
            {entries[kind].map((entry, i) => (
              <div className={s.historyEntry} key={i}>
                <div className={s.historyHead}>
                  <strong>{i + 1}. {entry.Company || entry.School || `New ${SECTIONS[kind].one}`}</strong>
                  <button
                    type="button"
                    className={s.ghostBtn}
                    onClick={() => remove(kind, i)}
                    title={`Remove this ${SECTIONS[kind].one}`}
                    aria-label={`Remove ${SECTIONS[kind].one} ${i + 1}`}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <div className={s.row}>
                  {SECTIONS[kind].fields.map(([field, placeholder]) => (
                    <label className={s.field} key={field}>
                      <span>{field}</span>
                      <input
                        value={entry[field] ?? ''}
                        placeholder={placeholder}
                        onChange={(e) => update(kind, i, field, e.target.value)}
                        onBlur={() => void persist(kind, entries[kind])}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div>
              <button
                type="button"
                className={s.ghostBtn}
                onClick={() => setEntries((all) => ({ ...all, [kind]: [...all[kind], {}] }))}
              >
                + Add {SECTIONS[kind].one}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
