'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../../components/Icon';
import { CommonQuestions } from '../../components/CommonQuestions';
import s from '../profile/profile.module.css';

interface Answer {
  id: string;
  canonicalKey: string | null;
  rawLabel: string;
  displayValue: string;
  fieldKind: string;
  source: 'USER' | 'PROFILE' | 'INFERRED';
  confidence: number;
  scope: string;
  timesUsed: number;
  lastUsedAt: string | null;
  updatedAt: string;
}

/**
 * The memory, made inspectable and editable.
 *
 * An answer bank you cannot see is a liability: it is submitting things under
 * your name that you may have answered carelessly six months ago. Everything
 * in here is editable and deletable.
 */
export default function AnswersPage() {
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftLabel, setDraftLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');

  const load = () =>
    api<{ answers: Answer[] }>('/api/answers')
      .then((d) => setAnswers(d.answers))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  async function save(id: string) {
    if (!draftLabel.trim() || !draft.trim()) return;
    try {
      await api(`/api/answers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ rawLabel: draftLabel.trim(), displayValue: draft.trim() }),
      });
      setEditing(null);
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function add() {
    if (!newLabel.trim() || !newValue.trim()) return;
    try {
      await api('/api/answers', {
        method: 'POST',
        body: JSON.stringify({ rawLabel: newLabel.trim(), displayValue: newValue.trim() }),
      });
      setAdding(false);
      setNewLabel('');
      setNewValue('');
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Forget your answer to "${label}"? You will be asked again next time.`)) return;
    await api(`/api/answers/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <span className={s.eyebrow}>Your answers</span>
          <h1>Answers</h1>
          <p>How you answer the questions application forms ask. Everything here is filled in for you, however a form words the question.</p>
        </div>
      </header>

      <CommonQuestions />

      <section className={s.section}>
        <div className={s.sectionHead}>
          <div className={s.sectionTitle}>
            <span className={s.sectionIcon}><Icon name="message" size={18} /></span>
            <div>
              <h2>Remembered from your applications</h2>
              <p>Answers you gave when a form asked something new. Reused automatically next time; edit anything that has gone stale.</p>
            </div>
          </div>
          <div className="row" style={{ gap: '.5rem', flexWrap: 'nowrap' }}>
            {answers.length > 0 && <span className={s.counter}><strong>{answers.length}</strong> remembered</span>}
            {!adding && <button className={s.ghostBtn} onClick={() => setAdding(true)}>Add question</button>}
          </div>
        </div>
        {error && <div className="notice bad">{error}</div>}
        {adding && (
          <div className={s.answers} style={{ marginBottom: '.75rem' }}>
            <div className={s.answer} style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto' }}>
              <input
                autoFocus
                placeholder="Question, as a form would ask it"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false); }}
              />
              <input
                placeholder="Your answer"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void add(); if (e.key === 'Escape') setAdding(false); }}
              />
              <div className="row" style={{ gap: '.3rem', flexWrap: 'nowrap' }}>
                <button className={`primary ${s.ghostBtn}`} disabled={!newLabel.trim() || !newValue.trim()} onClick={add}>Save</button>
                <button className={s.ghostBtn} onClick={() => { setAdding(false); setNewLabel(''); setNewValue(''); }}>Cancel</button>
              </div>
            </div>
          </div>
        )}
        {answers.length === 0 && !adding ? (
          <div className={s.locked}>Nothing yet. When a form asks something new, your answer is kept here. You can also add questions yourself.</div>
        ) : answers.length > 0 && (
          <div className={s.answers}>
            {answers.map((a) => (
              <div className={s.answer} key={a.id} style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto' }}>
                <div>
                  {editing === a.id ? (
                    <input value={draftLabel} onChange={(e) => setDraftLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
                  ) : (
                    <div style={{ fontSize: 'var(--fs-sm)' }}>{a.rawLabel}</div>
                  )}
                  <div className="muted small" style={{ marginTop: '.15rem' }}>
                    {a.source === 'USER' ? 'You answered' : a.source === 'INFERRED' ? `Worked out from your resume · ${Math.round(a.confidence * 100)}% sure` : 'From your profile'}
                    {a.timesUsed > 0 && ` · used ${a.timesUsed}×`}
                  </div>
                </div>
                {editing === a.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void save(a.id); if (e.key === 'Escape') setEditing(null); }}
                  />
                ) : (
                  <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>{a.displayValue}</div>
                )}
                <div className="row" style={{ gap: '.3rem', flexWrap: 'nowrap' }}>
                  {editing === a.id ? (
                    <>
                      <button className={`primary ${s.ghostBtn}`} onClick={() => save(a.id)}>Save</button>
                      <button className={s.ghostBtn} onClick={() => setEditing(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className={s.ghostBtn} onClick={() => { setEditing(a.id); setDraft(a.displayValue); setDraftLabel(a.rawLabel); }}>Edit</button>
                      <button className={`ghost ${s.ghostBtn}`} style={{ color: 'var(--muted)' }} onClick={() => remove(a.id, a.rawLabel)}>Forget</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
