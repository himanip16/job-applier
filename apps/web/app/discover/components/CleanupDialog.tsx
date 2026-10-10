'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';

type Status = 'ALL' | 'NEW' | 'SHORTLISTED' | 'REJECTED' | 'APPLIED' | 'EXPIRED';
interface Outcome {
  deleted: number;
  byStatus: Record<string, number>;
  samples: string[];
}

/**
 * Delete old or low-scoring jobs, in bulk.
 *
 * Always previews first: the delete button only appears once you have seen
 * how many would go and a few of their titles, and it deletes exactly what
 * the preview counted.
 */
export function CleanupDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const [olderThanDays, setOlderThanDays] = useState(20);
  const [status, setStatus] = useState<Status>('ALL');
  const [maxScore, setMaxScore] = useState(40);
  const [quickScoreOnly, setQuickScoreOnly] = useState(false);
  const [preview, setPreview] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any change to the criteria makes the old preview a lie.
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPreview(null);
  };

  async function send(dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<Outcome>('/api/leads/cleanup', {
        method: 'POST',
        body: JSON.stringify({ olderThanDays, status, maxScore, quickScoreOnly, dryRun }),
      });
      if (dryRun) setPreview(result);
      else onDone(`Deleted ${result.deleted} job${result.deleted === 1 ? '' : 's'}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 .2rem' }}>Clean up old jobs</h2>
        <p className="sub">Delete jobs that are both older and lower-scoring than you choose. You see the count before anything goes.</p>

        <label className="field">
          <span>Older than (days)</span>
          <input
            type="number"
            min={1}
            max={365}
            value={olderThanDays}
            onChange={(e) => edit(setOlderThanDays)(Number(e.target.value) || 1)}
          />
        </label>
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => edit(setStatus)(e.target.value as Status)}>
            <option value="ALL">All statuses</option>
            <option value="NEW">New</option>
            <option value="SHORTLISTED">Saved</option>
            <option value="REJECTED">Dismissed</option>
            <option value="APPLIED">Applied</option>
            <option value="EXPIRED">Expired</option>
          </select>
        </label>
        <label className="field">
          <span>Match below</span>
          <input
            type="number"
            min={0}
            max={100}
            value={maxScore}
            onChange={(e) => edit(setMaxScore)(Number(e.target.value) || 0)}
          />
        </label>
        <label className="row small muted" style={{ gap: '.35rem', marginBottom: '.8rem' }}>
          <input type="checkbox" checked={quickScoreOnly} onChange={(e) => edit(setQuickScoreOnly)(e.target.checked)} />
          Only jobs that were never read in full
        </label>

        {preview && (
          <div className="notice" style={{ marginBottom: '.8rem' }}>
            <strong>{preview.deleted} job{preview.deleted === 1 ? '' : 's'} would be deleted.</strong>
            {Object.keys(preview.byStatus).length > 0 && (
              <div className="small muted">
                {Object.entries(preview.byStatus).map(([s, c]) => `${s}: ${c}`).join(', ')}
              </div>
            )}
            {preview.samples.length > 0 && (
              <ul className="small muted" style={{ margin: '.3rem 0 0 1.2rem' }}>
                {preview.samples.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <div className="notice bad" style={{ marginBottom: '.8rem' }}>{error}</div>}

        <div className="row">
          {preview && preview.deleted > 0 ? (
            <button className="primary" disabled={busy} onClick={() => send(false)}>
              {busy ? 'Deleting…' : `Delete ${preview.deleted}`}
            </button>
          ) : (
            <button className="primary" disabled={busy} onClick={() => send(true)}>
              {busy ? 'Counting…' : 'Preview'}
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
