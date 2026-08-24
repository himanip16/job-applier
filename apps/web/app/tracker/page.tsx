'use client';

import { useCallback, useEffect, useState } from 'react';
import { API, api } from '../../lib/api';

const OUTCOMES = ['IN_PROGRESS', 'REJECTED', 'GHOSTED', 'WITHDRAWN', 'OFFER', 'ACCEPTED', 'DECLINED'] as const;
const ROUND_STATUS = ['SCHEDULED', 'PENDING_RESULT', 'PASSED', 'FAILED', 'CANCELLED'] as const;
const LESSON_CATEGORIES = ['preparation', 'communication', 'technical', 'fit', 'logistics'] as const;

interface Question {
  id: string;
  question: string;
  myAnswer: string | null;
  selfRating: string | null;
  category: string | null;
}
interface Round {
  id: string;
  name: string;
  sequence: number;
  status: string;
  scheduledAt: string | null;
  format: string | null;
  interviewers: string | null;
  notes: string | null;
  questions: Question[];
}
interface LessonRow {
  id: string;
  text: string;
  category: string | null;
}
interface Row {
  id: string;
  status: string;
  outcome: string;
  outcomeNote: string | null;
  notes: string | null;
  submittedAt: string | null;
  job: { title: string; company: string; url: string; ats: string };
  rounds: Round[];
  lessons: LessonRow[];
  resumeUsed: { label: string; filename: string } | null;
  tailoredUsed: { id: string; label: string; coverage: number; docxPath: string | null } | null;
}

export default function TrackerPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('ALL');
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ applications: Row[]; stats: Record<string, number> }>(
        `/api/tracker?outcome=${filter}`,
      );
      setRows(d.applications);
      setStats(d.stats);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const total = Object.values(stats).reduce((a, b) => a + b, 0);

  return (
    <>
      <div className="panel">
        <h2>Applications</h2>
        <p className="sub">
          What went out, where it stands, and what you learned. <em>Status</em> is how far the
          automation got; <em>outcome</em> is where you stand with the employer — they are different
          facts and both are worth keeping.
        </p>
        <div className="row">
          {['ALL', ...OUTCOMES].map((o) => (
            <button
              key={o}
              onClick={() => setFilter(o)}
              style={filter === o ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--accent)' } : undefined}
            >
              {o.replace('_', ' ').toLowerCase()} {o === 'ALL' ? `(${total})` : stats[o] ? `(${stats[o]})` : ''}
            </button>
          ))}
        </div>
        {error && <div className="notice bad" style={{ marginTop: '.8rem' }}>{error}</div>}
      </div>

      {rows.length === 0 ? (
        <div className="panel">
          <div className="empty-state">Nothing tracked yet. Applications appear here once you apply.</div>
        </div>
      ) : (
        rows.map((row) => (
          <ApplicationRow
            key={row.id}
            row={row}
            open={openId === row.id}
            onToggle={() => setOpenId(openId === row.id ? null : row.id)}
            onChange={load}
          />
        ))
      )}
    </>
  );
}

function ApplicationRow({
  row,
  open,
  onToggle,
  onChange,
}: {
  row: Row;
  open: boolean;
  onToggle: () => void;
  onChange: () => void;
}) {
  async function setOutcome(outcome: string) {
    await api(`/api/tracker/${row.id}`, { method: 'PATCH', body: JSON.stringify({ outcome }) });
    onChange();
  }

  return (
    <div className="panel">
      <div className="spread">
        <div>
          <div className="row" style={{ gap: '.5rem' }}>
            <a href={row.job.url} target="_blank" rel="noreferrer">
              <strong>{row.job.title}</strong>
            </a>
            <span className="muted small">· {row.job.company}</span>
            <span className={`pill ${row.status}`}>{row.status.replace('_', ' ')}</span>
          </div>
          <div className="muted small" style={{ marginTop: '.25rem' }}>
            {row.submittedAt ? `Submitted ${new Date(row.submittedAt).toLocaleDateString()}` : 'Not submitted'}
            {row.resumeUsed ? ` · resume: ${row.resumeUsed.filename}` : ''}
            {row.tailoredUsed
              ? ` · tailored (${Math.round(row.tailoredUsed.coverage)}% keyword coverage)`
              : ''}
            {row.rounds.length ? ` · ${row.rounds.length} round(s)` : ''}
            {row.lessons.length ? ` · ${row.lessons.length} lesson(s)` : ''}
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <select value={row.outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: 'auto' }}>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o.replace('_', ' ').toLowerCase()}
              </option>
            ))}
          </select>
          <button onClick={onToggle}>{open ? 'Close' : 'Open'}</button>
        </div>
      </div>

      {row.tailoredUsed?.docxPath && (
        <div className="small" style={{ marginTop: '.5rem' }}>
          <a href={`${API}/files/resumes/${row.tailoredUsed.docxPath.replace(/^resumes\//, '')}`}>
            Download the resume that went out
          </a>
        </div>
      )}

      {open && (
        <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
          <NotesBlock row={row} onChange={onChange} />
          <RoundsBlock row={row} onChange={onChange} />
          <LessonsBlock row={row} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

function NotesBlock({ row, onChange }: { row: Row; onChange: () => void }) {
  const [notes, setNotes] = useState(row.notes ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <label className="field">
      <span>Notes — recruiter, referral, comp discussed</span>
      <textarea
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          setSaved(false);
        }}
        onBlur={async () => {
          if (notes === (row.notes ?? '')) return;
          await api(`/api/tracker/${row.id}`, { method: 'PATCH', body: JSON.stringify({ notes }) });
          setSaved(true);
          onChange();
        }}
      />
      {saved && <span className="small" style={{ color: 'var(--good)' }}>Saved.</span>}
    </label>
  );
}

function RoundsBlock({ row, onChange }: { row: Row; onChange: () => void }) {
  const [name, setName] = useState('');
  const [format, setFormat] = useState('');

  return (
    <div style={{ marginTop: '.5rem' }}>
      <h2 style={{ fontSize: '.95rem' }}>Interview rounds</h2>
      {row.rounds.map((round) => (
        <RoundCard key={round.id} round={round} onChange={onChange} />
      ))}

      <form
        className="row"
        style={{ marginTop: '.6rem' }}
        onSubmit={async (e) => {
          e.preventDefault();
          await api(`/api/tracker/${row.id}/rounds`, {
            method: 'POST',
            body: JSON.stringify({ name, format: format || undefined }),
          });
          setName('');
          setFormat('');
          onChange();
        }}
      >
        <input
          type="text"
          required
          placeholder="Round name, e.g. Recruiter screen"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: '2 1 14rem' }}
        />
        <input
          type="text"
          placeholder="Format (phone, onsite, take-home)"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          style={{ flex: '1 1 10rem' }}
        />
        <button>Add round</button>
      </form>
    </div>
  );
}

function RoundCard({ round, onChange }: { round: Round; onChange: () => void }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [rating, setRating] = useState<'GOOD' | 'OK' | 'POOR'>('OK');
  const [reuse, setReuse] = useState(false);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '.7rem .8rem',
        marginTop: '.5rem',
      }}
    >
      <div className="spread">
        <strong>
          {round.sequence + 1}. {round.name}
          {round.format ? <span className="muted small"> · {round.format}</span> : null}
        </strong>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <select
            value={round.status}
            style={{ width: 'auto' }}
            onChange={async (e) => {
              await api(`/api/rounds/${round.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: e.target.value }),
              });
              onChange();
            }}
          >
            {ROUND_STATUS.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ').toLowerCase()}
              </option>
            ))}
          </select>
          <button
            className="danger"
            onClick={async () => {
              await api(`/api/rounds/${round.id}`, { method: 'DELETE' });
              onChange();
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {round.questions.length > 0 && (
        <table style={{ marginTop: '.5rem' }}>
          <tbody>
            {round.questions.map((q) => (
              <tr key={q.id}>
                <td style={{ width: '45%' }}>{q.question}</td>
                <td className="muted small">{q.myAnswer ?? '—'}</td>
                <td>
                  {q.selfRating && (
                    <span
                      className="src"
                      style={{
                        color:
                          q.selfRating === 'GOOD'
                            ? 'var(--good)'
                            : q.selfRating === 'POOR'
                              ? 'var(--bad)'
                              : 'var(--warn)',
                      }}
                    >
                      {q.selfRating}
                    </span>
                  )}
                </td>
                <td>
                  <button
                    className="danger"
                    onClick={async () => {
                      await api(`/api/questions/${q.id}`, { method: 'DELETE' });
                      onChange();
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form
        style={{ marginTop: '.5rem' }}
        onSubmit={async (e) => {
          e.preventDefault();
          await api(`/api/rounds/${round.id}/questions`, {
            method: 'POST',
            body: JSON.stringify({
              question,
              myAnswer: answer || undefined,
              selfRating: rating,
              reuseAnswer: reuse,
            }),
          });
          setQuestion('');
          setAnswer('');
          setReuse(false);
          onChange();
        }}
      >
        <div className="row">
          <input
            type="text"
            required
            placeholder="A question they asked"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            style={{ flex: '2 1 16rem' }}
          />
          <input
            type="text"
            placeholder="What you said"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            style={{ flex: '2 1 14rem' }}
          />
          <select value={rating} onChange={(e) => setRating(e.target.value as 'GOOD' | 'OK' | 'POOR')} style={{ width: 'auto' }}>
            <option value="GOOD">went well</option>
            <option value="OK">ok</option>
            <option value="POOR">went badly</option>
          </select>
          <button>Add</button>
        </div>
        <label className="row small" style={{ marginTop: '.35rem' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={reuse}
            onChange={(e) => setReuse(e.target.checked)}
          />
          <span className="muted">
            Save my answer to the answer bank — application forms ask these too
          </span>
        </label>
      </form>
    </div>
  );
}

function LessonsBlock({ row, onChange }: { row: Row; onChange: () => void }) {
  const [text, setText] = useState('');
  const [category, setCategory] = useState<string>('preparation');

  return (
    <div style={{ marginTop: '1rem' }}>
      <h2 style={{ fontSize: '.95rem' }}>What I think I got wrong</h2>
      <p className="sub" style={{ marginBottom: '.5rem' }}>
        Written down now, while you still remember. This is the table that is worth the most after a
        couple of months.
      </p>
      {row.lessons.map((l) => (
        <div key={l.id} className="spread" style={{ padding: '.3rem 0' }}>
          <span className="small">
            {l.category && <span className="src">{l.category}</span>} {l.text}
          </span>
          <button
            className="danger"
            onClick={async () => {
              await api(`/api/lessons/${l.id}`, { method: 'DELETE' });
              onChange();
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <form
        className="row"
        style={{ marginTop: '.5rem' }}
        onSubmit={async (e) => {
          e.preventDefault();
          await api(`/api/tracker/${row.id}/lessons`, {
            method: 'POST',
            body: JSON.stringify({ text, category }),
          });
          setText('');
          onChange();
        }}
      >
        <input
          type="text"
          required
          placeholder="e.g. rambled on the system design question, should have drawn it first"
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: '3 1 20rem' }}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 'auto' }}>
          {LESSON_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button>Add</button>
      </form>
    </div>
  );
}
