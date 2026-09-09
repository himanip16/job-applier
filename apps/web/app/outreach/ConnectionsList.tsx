'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface ConnectionsPage {
  connections: {
    id: string;
    fullName: string;
    headline: string | null;
    companyName: string;
    profileUrl: string;
    role: string;
    location: string | null;
  }[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const roleLabels: Record<string, string> = {
  TALENT: 'Recruiting', ENGINEERING: 'Engineering leadership', OTHER: 'Other',
};

export default function ConnectionsList({ refreshKey }: { refreshKey: number }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<ConnectionsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<ConnectionsPage>(`/api/linkedin/connections?page=${page}&pageSize=${pageSize}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load connections.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, pageSize, refreshKey, retry]);

  return (
    <section aria-labelledby="connections-heading" style={{ margin: '1.5rem 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <h3 id="connections-heading">All connections{data ? ` (${data.total.toLocaleString()})` : ''}</h3>
          <p className="small muted">Everyone synced from LinkedIn, listed alphabetically.</p>
        </div>
        <label className="field">
          <span>Per page</span>
          <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
            {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>
      {loading ? <p role="status">Loading connections…</p> : error ? (
        <div role="alert"><p>{error}</p><button onClick={() => setRetry((value) => value + 1)}>Try again</button></div>
      ) : data && data.total === 0 ? (
        <p role="status">No connections have been synced yet. Use Sync Connections above to import your LinkedIn connections.</p>
      ) : data && (
        <>
          <ul aria-label="LinkedIn connections" style={{ listStyle: 'none', padding: 0, margin: '1rem 0' }}>
            {data.connections.map((connection) => (
              <li key={connection.id} style={{ padding: '1rem 0', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: '1 1 240px', overflowWrap: 'anywhere' }}>
                  <a href={connection.profileUrl} target="_blank" rel="noreferrer"><strong>{connection.fullName}</strong></a>
                  {connection.headline && <p style={{ margin: '0.35rem 0' }}>{connection.headline}</p>}
                  <span className="small muted">{[connection.companyName === 'Unknown' ? null : connection.companyName, connection.location].filter(Boolean).join(' · ')}</span>
                </div>
                <span className="small muted">{roleLabels[connection.role] ?? connection.role}</span>
              </li>
            ))}
          </ul>
          <nav aria-label="Connections pagination" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <span className="small muted" role="status">
              {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total.toLocaleString()} connections
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <button disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Previous</button>
              <span>Page {data.page} of {data.totalPages}</span>
              <button disabled={data.page >= data.totalPages} onClick={() => setPage(data.page + 1)}>Next</button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}
