'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

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

  const load = () =>
    api<{ answers: Answer[] }>('/api/answers')
      .then((d) => setAnswers(d.answers))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  async function save(id: string) {
    await api(`/api/answers/${id}`, { method: 'PATCH', body: JSON.stringify({ displayValue: draft }) });
    setEditing(null);
    await load();
  }

  async function remove(id: string) {
    await api(`/api/answers/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <div className="panel">
      <h2>Answer bank</h2>
      <p className="sub">
        Every answer learned so far. These are reused automatically when the same question comes up
        again, however it is worded. Edit anything that has gone stale.
      </p>
      {error && <div className="notice bad">{error}</div>}
      {answers.length === 0 ? (
        <p className="muted small">
          Empty. It fills itself in as you answer questions during applications.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Answer</th>
              <th>Source</th>
              <th>Used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {answers.map((a) => (
              <tr key={a.id}>
                <td style={{ maxWidth: '24rem' }}>
                  {a.rawLabel}
                  {a.canonicalKey && <div className="muted small">{a.canonicalKey}</div>}
                </td>
                <td style={{ maxWidth: '18rem' }}>
                  {editing === a.id ? (
                    <div className="row">
                      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
                      <button className="primary" onClick={() => save(a.id)}>
                        Save
                      </button>
                    </div>
                  ) : (
                    a.displayValue
                  )}
                </td>
                <td>
                  <span className={`src ${a.source}`}>{a.source}</span>
                  {a.source === 'INFERRED' && (
                    <div className="muted small">{Math.round(a.confidence * 100)}% confident</div>
                  )}
                </td>
                <td className="small muted">{a.timesUsed}&times;</td>
                <td>
                  <div className="row">
                    <button
                      onClick={() => {
                        setEditing(a.id);
                        setDraft(a.displayValue);
                      }}
                    >
                      Edit
                    </button>
                    <button className="danger" onClick={() => remove(a.id)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
