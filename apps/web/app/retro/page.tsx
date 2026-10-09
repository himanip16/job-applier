'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Loading } from '../../components/Loading';

interface Retro {
  lessons: { id: string; text: string; category: string | null; job: string; round: string | null }[];
  lessonsByCategory: Record<string, number>;
  recurringQuestions: { question: string; asked: number; companies: string[]; answers: string[] }[];
  outcomes: Record<string, number>;
}

/**
 * The view that pays for the whole tracker.
 *
 * Two things are worth looking at across a search rather than per application:
 * the questions several companies asked you (prepare those properly), and the
 * mistakes you keep making (that is the pattern, not bad luck).
 */
export default function RetroPage() {
  const [data, setData] = useState<Retro | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Retro>('/api/retrospective').then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="panel"><div className="notice bad">{error}</div></div>;
  if (!data) return <Loading />;

  const total = Object.values(data.outcomes).reduce((a, b) => a + b, 0);
  const offers = (data.outcomes.OFFER ?? 0) + (data.outcomes.ACCEPTED ?? 0);
  const rejected = data.outcomes.REJECTED ?? 0;

  return (
    <>
      <div className="panel">
        <h2>How the search is going</h2>
        {total === 0 ? (
          <div className="empty-state">No applications tracked yet.</div>
        ) : (
          <div className="row" style={{ gap: '2rem', marginTop: '.5rem' }}>
            <Stat label="applications" value={total} />
            <Stat label="offers" value={offers} tone="var(--good)" />
            <Stat label="rejections" value={rejected} tone="var(--bad)" />
            <Stat label="no reply" value={data.outcomes.GHOSTED ?? 0} tone="var(--muted)" />
            <Stat
              label="offer rate"
              value={total ? `${Math.round((offers / total) * 100)}%` : '—'}
            />
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Questions you keep being asked</h2>
        <p className="sub">
          Sorted by how many times they have come up. Anything asked twice is worth an answer you
          have actually rehearsed.
        </p>
        {data.recurringQuestions.length === 0 ? (
          <div className="empty-state">Nothing recorded yet. Add questions as you go in the tracker.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Question</th><th>Asked</th><th>Where</th><th>Your answer</th></tr>
            </thead>
            <tbody>
              {data.recurringQuestions.map((q) => (
                <tr key={q.question}>
                  <td style={{ maxWidth: '24rem' }}>{q.question}</td>
                  <td>
                    <strong style={{ color: q.asked > 1 ? 'var(--warn)' : undefined }}>{q.asked}×</strong>
                  </td>
                  <td className="muted small">{q.companies.join(', ')}</td>
                  <td className="muted small" style={{ maxWidth: '18rem' }}>
                    {q.answers[0] ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>What keeps going wrong</h2>
        {Object.keys(data.lessonsByCategory).length > 0 && (
          <div className="row" style={{ marginBottom: '.8rem' }}>
            {Object.entries(data.lessonsByCategory)
              .sort((a, b) => b[1] - a[1])
              .map(([cat, n]) => (
                <span key={cat} className="src">
                  {cat} · {n}
                </span>
              ))}
          </div>
        )}
        {data.lessons.length === 0 ? (
          <div className="empty-state">
            Nothing written down yet. After each interview, note what you would do differently
            while you still remember it.
          </div>
        ) : (
          <table>
            <tbody>
              {data.lessons.map((l) => (
                <tr key={l.id}>
                  <td style={{ width: '8rem' }}>
                    {l.category && <span className="src">{l.category}</span>}
                  </td>
                  <td>{l.text}</td>
                  <td className="muted small">
                    {l.job}
                    {l.round ? ` · ${l.round}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div>
      <div style={{ fontSize: '1.6rem', fontWeight: 600, color: tone }}>{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}
