'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { CompanyManager } from '../discover/components/CompanyManager';
import type { Company } from '../discover/types';

/**
 * The companies "Search my watch list" reads.
 *
 * "Search top companies" adds every company it reads here, and you can add
 * more by hand. This page is the only place the list is shown.
 */
export default function WatchlistPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sources, setSources] = useState<{ id: string; handleHint: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await api<{ companies: Company[] }>('/api/companies');
      setCompanies(c.companies);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    api<{ sources: { id: string; handleHint: string }[] }>('/api/sources')
      .then((d) => setSources(d.sources))
      .catch(() => {});
  }, [load]);

  const failing = companies.filter((c) => c.lastCrawlNote?.startsWith('failed')).length;

  return (
    <div>
      <span className="section-title">Find work</span>
      <h1>Watch list</h1>
      <p className="sub" style={{ maxWidth: '46rem' }}>
        {companies.length} compan{companies.length === 1 ? 'y' : 'ies'}
        {failing ? ` · ${failing} failed on the last read` : ''}. &ldquo;Search my watch list&rdquo; on Find work re-reads
        all of these for new jobs.
      </p>
      {error && <div className="notice bad" style={{ marginBottom: '.9rem' }}>{error}</div>}
      <CompanyManager companies={companies} sources={sources} onChange={load} />
    </div>
  );
}
