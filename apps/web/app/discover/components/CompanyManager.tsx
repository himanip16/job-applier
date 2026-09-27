'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import { Icon } from '../../../components/Icon';
import type { Company } from '../types';

export function CompanyManager({
  companies,
  sources,
  onChange,
}: {
  companies: Company[];
  sources: { id: string; handleHint: string }[];
  onChange: () => void;
}) {
  const [name, setName] = useState('');
  const [source, setSource] = useState('greenhouse');
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const hint = sources.find((s) => s.id === source)?.handleHint ?? '';

  const filteredCompanies = companies.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.source.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.handle.toLowerCase().includes(searchQuery.toLowerCase())
  );

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/companies', { method: 'POST', body: JSON.stringify({ name, source, handle }) });
      setName('');
      setHandle('');
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="panel">
      <h2>Boards it watches</h2>
      <p className="sub">
        Search adds companies here automatically as it finds them, so their future openings arrive
        without spending another search. Add one by hand when you already know you want to watch
        it. Four of these read the board&apos;s own public postings API — structured, complete, and
        far more reliable than scraping. &ldquo;careers-page&rdquo; is a real crawl, for companies
        that host their own.
      </p>
      <form onSubmit={add}>
        <div className="row">
          <input
            type="text"
            placeholder="Company name"
            value={name}
            required
            onChange={(e) => setName(e.target.value)}
            style={{ flex: '1 1 12rem' }}
          />
          <select value={source} onChange={(e) => setSource(e.target.value)} style={{ flex: '0 0 10rem' }}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder={hint}
            value={handle}
            required
            onChange={(e) => setHandle(e.target.value)}
            style={{ flex: '2 1 16rem' }}
          />
          <button className="primary">Add</button>
        </div>
        <div className="muted small" style={{ marginTop: '.35rem' }}>
          {hint}
        </div>
      </form>
      {error && <div className="notice bad" style={{ marginTop: '.7rem' }}>{error}</div>}

      {companies.length > 0 && (
        <>
          <div style={{ marginTop: '.9rem', marginBottom: '.5rem' }}>
            <input
              type="text"
              placeholder="Search companies..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: '100%', padding: '0.5rem' }}
            />
          </div>
          <table style={{ marginTop: '.9rem' }}>
            <tbody>
              {filteredCompanies.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="muted small">
                  {c.source} · {c.handle}
                </td>
                <td className="muted small">
                  {c.lastCrawledAt ? c.lastCrawlNote : 'never crawled'}
                </td>
                <td>
                  <button
                    className="danger"
                    onClick={async () => {
                      await api(`/api/companies/${c.id}`, { method: 'DELETE' });
                      onChange();
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredCompanies.length === 0 && searchQuery && (
          <div className="muted small" style={{ marginTop: '.5rem' }}>
            No companies match "{searchQuery}"
          </div>
        )}
        </>
      )}
    </div>
  );
}
