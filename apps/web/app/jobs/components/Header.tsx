'use client';

import React from 'react';
import { Detail } from './types';

export function Header({ d }: { d: Detail }) {
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
            <a href={d.job.url} target="_blank" rel="noreferrer">
              <button>Open posting</button>
            </a>
          )}
          {d.nextAction && (
            <a href={d.nextAction.href}>
              <button className={d.nextAction.urgent ? 'primary' : undefined}>{d.nextAction.label}</button>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default Header;
