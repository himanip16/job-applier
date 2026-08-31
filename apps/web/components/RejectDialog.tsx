'use client';

import { useState } from 'react';
import { api } from '../lib/api';

interface Lead {
  id: string;
  title: string;
  companyName: string;
}

interface RejectDialogProps {
  lead: Lead;
  categories: string[];
  onClose: () => void;
  onDone: (message: string) => void;
}

/**
 * The reject dialog.
 *
 * The reason is optional and says so. Forcing one gets you "n/a", and "n/a"
 * actively poisons the learner — worse than no answer at all. The category
 * chips exist because one tap is cheap and still carries real signal.
 */
export function RejectDialog({ lead, categories, onClose, onDone }: RejectDialogProps) {
  const [category, setCategory] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const rRaw = await api(`/api/leads/${lead.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ category: category ?? undefined, reason: reason.trim() || undefined }),
      });
      const r = rRaw as { message: string };
      onDone(r.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 .2rem' }}>Not for you</h2>
        <p className="sub">
          {lead.title} at {lead.companyName}. Telling us why is optional, but it is what teaches the
          ranking — a reason moves it far more than a bare rejection does.
        </p>

        <div className="row" style={{ marginBottom: '.8rem' }}>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(category === c ? null : c)}
              style={category === c ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--accent)' } : undefined}
            >
              {c}
            </button>
          ))}
        </div>

        <label className="field">
          <span>Anything else? (optional)</span>
          <textarea
            value={reason}
            placeholder="e.g. the commute is impossible, or I have moved away from PHP"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        <div className="row">
          <button className="primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : 'Reject'}
          </button>
          <button onClick={onClose}>Cancel</button>
          <span className="muted small">Skipping the reason is fine.</span>
        </div>
      </div>
    </div>
  );
}
