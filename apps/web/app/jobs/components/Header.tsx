'use client';

import React from 'react';
import { Detail } from './types';
import { api } from '../../../lib/api';

export function Header({ d, onReject, onApply }: { d: Detail; onReject?: () => void; onApply?: () => void }) {
  const [applying, setApplying] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);

  const handleApply = async () => {
    if (!d.lead) {
      setApplyError('No lead found for this job');
      return;
    }

    setApplying(true);
    setApplyError(null);
    try {
      await api(`/api/leads/${d.lead.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ requiresReview: true, writeCoverLetter: false, autoTailorResume: true }),
      });
      onApply?.();
    } catch (e) {
      setApplyError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="panel">
      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: '1.5rem', margin: 0, letterSpacing: '-.01em' }}>{d.job.title}</h1>
          <div className="row" style={{ gap: '.5rem', marginTop: '.25rem' }}>
            <strong>{d.job.company || 'Unknown company'}</strong>
            {d.job.location && <span className="muted small">{d.job.location}</span>}
            {d.job.remote && <span className="src">remote</span>}
            <span className="src">{d.job.ats}</span>
          </div>
        </div>
        <div className="row" style={{ flex: 'none', gap: '.5rem' }}>
          {d.job.url && (
            <>
              <button className="primary" onClick={handleApply} disabled={applying || !d.lead}>
                {applying ? 'Applying…' : 'Apply'}
              </button>
              <a href={d.job.url} target="_blank" rel="noreferrer">
                <button>Open posting</button>
              </a>
            </>
          )}
          {d.lead && d.lead.status !== 'REJECTED' && onReject && (
            <button onClick={onReject}>Reject</button>
          )}
          {d.nextAction && (
            <a href={d.nextAction.href}>
              <button className={d.nextAction.urgent ? 'primary' : undefined}>{d.nextAction.label}</button>
            </a>
          )}
        </div>
      </div>
      {applyError && (
        <div className="notice bad" style={{ marginTop: '.6rem' }}>
          {applyError}
        </div>
      )}
    </div>
  );
}

export default Header;
