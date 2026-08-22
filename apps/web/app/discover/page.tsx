'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface Lead {
  id: string;
  url: string;
  ats: string;
  title: string;
  companyName: string;
  location: string | null;
  remote: boolean;
  descriptionText: string | null;
  score: number;
  deepScored: boolean;
  scoreReasons: {
    verdict?: string;
    seniorityFit?: string;
    forIt?: string[];
    againstIt?: string[];
    dealbreaker?: string;
    likedTerms?: string[];
    dislikedTerms?: string[];
  } | null;
  status: string;
}

interface Company {
  id: string;
  name: string;
  source: string;
  handle: string;
  lastCrawledAt: string | null;
  lastCrawlNote: string | null;
}

export default function DiscoverPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sources, setSources] = useState<{ id: string; handleHint: string }[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [filter, setFilter] = useState('NEW');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Lead | null>(null);

  const load = useCallback(async () => {
    const [l, c] = await Promise.all([
      api<{ leads: Lead[]; counts: Record<string, number> }>(`/api/leads?status=${filter}`),
      api<{ companies: Company[] }>('/api/companies'),
    ]);
    setLeads(l.leads);
    setCounts(l.counts);
    setCompanies(c.companies);
  }, [filter]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    api<{ sources: { id: string; handleHint: string }[]; rejectCategories: string[] }>('/api/sources')
      .then((d) => {
        setSources(d.sources);
        setCategories(d.rejectCategories);
      })
      .catch(() => {});
  }, [load]);

  async function crawl() {
    setBusy('crawl');
    setError(null);
    setFlash(null);
    try {
      const { report } = await api<{ report: Record<string, number | unknown[]> }>(
        '/api/discovery/crawl',
        { method: 'POST', body: JSON.stringify({ deepScoreTop: 15 }) },
      );
      const errs = (report.errors as { company: string; error: string }[]) ?? [];
      setFlash(
        `Crawled ${report.companiesCrawled} boards, saw ${report.jobsSeen} postings, ${report.newLeads} new. ` +
          `${report.deepScored} read in full.` +
          (errs.length ? ` ${errs.length} board(s) failed: ${errs.map((e) => e.company).join(', ')}.` : ''),
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function decide(lead: Lead, action: 'apply' | 'shortlist') {
    setBusy(lead.id);
    try {
      if (action === 'apply') {
        const r = await api<{ applicationId: string }>(`/api/leads/${lead.id}/apply`, { method: 'POST' });
        window.location.href = `/applications/${r.applicationId}`;
        return;
      }
      await api(`/api/leads/${lead.id}/shortlist`, { method: 'POST' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="panel">
        <div className="spread">
          <div>
            <h2>Find work</h2>
            <p className="sub" style={{ margin: 0 }}>
              Reads each company&apos;s board, scores every posting against your profile and your
              past decisions, and puts the plausible ones in front of you.
            </p>
          </div>
          <button className="primary" disabled={busy === 'crawl' || !companies.length} onClick={crawl}>
            {busy === 'crawl' ? 'Crawling…' : 'Crawl now'}
          </button>
        </div>
        {flash && <div className="notice good" style={{ marginTop: '.9rem' }}>{flash}</div>}
        {error && <div className="notice bad" style={{ marginTop: '.9rem' }}>{error}</div>}
        {!companies.length && (
          <div className="notice" style={{ marginTop: '.9rem' }}>
            Add a company below first. Nothing to crawl yet.
          </div>
        )}
      </div>

      <CompanyManager companies={companies} sources={sources} onChange={load} />

      <div className="panel">
        <div className="spread">
          <h2>Leads</h2>
          <div className="row">
            {['NEW', 'SHORTLISTED', 'APPLIED', 'REJECTED', 'ALL'].map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                style={filter === s ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
              >
                {s.toLowerCase()} {counts[s] !== undefined ? `(${counts[s]})` : ''}
              </button>
            ))}
          </div>
        </div>

        {leads.length === 0 ? (
          <p className="muted small" style={{ marginTop: '.8rem' }}>
            Nothing here.
          </p>
        ) : (
          leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              busy={busy === lead.id}
              onApply={() => decide(lead, 'apply')}
              onShortlist={() => decide(lead, 'shortlist')}
              onReject={() => setRejecting(lead)}
            />
          ))
        )}
      </div>

      {rejecting && (
        <RejectDialog
          lead={rejecting}
          categories={categories}
          onClose={() => setRejecting(null)}
          onDone={async (msg) => {
            setRejecting(null);
            setFlash(msg);
            await load();
          }}
        />
      )}
    </>
  );
}

function LeadCard({
  lead,
  busy,
  onApply,
  onShortlist,
  onReject,
}: {
  lead: Lead;
  busy: boolean;
  onApply: () => void;
  onShortlist: () => void;
  onReject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const r = lead.scoreReasons ?? {};
  const score = Math.round(lead.score);
  const tone = score >= 70 ? 'var(--good)' : score >= 45 ? 'var(--warn)' : 'var(--bad)';

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: '.9rem 0',
      }}
    >
      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: '.5rem' }}>
            <strong style={{ color: tone, fontVariantNumeric: 'tabular-nums' }}>{score}</strong>
            <a href={lead.url} target="_blank" rel="noreferrer">
              {lead.title}
            </a>
            <span className="muted small">· {lead.companyName}</span>
            {lead.remote && <span className="src">remote</span>}
            {lead.location && <span className="muted small">{lead.location}</span>}
            {!lead.deepScored && <span className="src" title="Ranked on keywords only, not read in full">quick score</span>}
          </div>

          {r.dealbreaker && (
            <div className="notice bad" style={{ marginTop: '.4rem' }}>
              Blocker: {r.dealbreaker}
            </div>
          )}
          {r.forIt?.length ? (
            <div className="small" style={{ marginTop: '.35rem', color: 'var(--good)' }}>
              + {r.forIt.slice(0, 2).join(' · ')}
            </div>
          ) : null}
          {r.againstIt?.length ? (
            <div className="small" style={{ color: 'var(--warn)' }}>
              − {r.againstIt.slice(0, 2).join(' · ')}
            </div>
          ) : null}
          {!lead.deepScored && (r.likedTerms?.length || r.dislikedTerms?.length) ? (
            <div className="muted small" style={{ marginTop: '.3rem' }}>
              matched: {[...(r.likedTerms ?? []), ...(r.dislikedTerms ?? [])].slice(0, 6).join(', ')}
            </div>
          ) : null}
        </div>

        {lead.status === 'NEW' && (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <button className="primary" disabled={busy} onClick={onApply}>
              Apply
            </button>
            <button disabled={busy} onClick={onShortlist}>
              Save
            </button>
            <button className="danger" disabled={busy} onClick={onReject}>
              Not for me
            </button>
          </div>
        )}
        {lead.status !== 'NEW' && <span className={`pill ${lead.status}`}>{lead.status}</span>}
      </div>

      <button
        className="small"
        style={{ marginTop: '.4rem', border: 0, background: 'none', padding: 0, color: 'var(--muted)' }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'hide' : 'show'} description
      </button>
      {open && (
        <pre
          className="small muted"
          style={{ whiteSpace: 'pre-wrap', marginTop: '.4rem', maxHeight: '14rem', overflow: 'auto' }}
        >
          {lead.descriptionText ?? 'No description captured.'}
        </pre>
      )}
    </div>
  );
}

/**
 * The reject dialog.
 *
 * The reason is optional and says so. Forcing one gets you "n/a", and "n/a"
 * actively poisons the learner — worse than no answer at all. The category
 * chips exist because one tap is cheap and still carries real signal.
 */
function RejectDialog({
  lead,
  categories,
  onClose,
  onDone,
}: {
  lead: Lead;
  categories: string[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [category, setCategory] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/api/leads/${lead.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ category: category ?? undefined, reason: reason.trim() || undefined }),
      });
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
              style={category === c ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
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

function CompanyManager({
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

  const hint = sources.find((s) => s.id === source)?.handleHint ?? '';

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
      <h2>Where to look</h2>
      <p className="sub">
        Four of these read the board&apos;s own public postings API, which is what the platforms
        publish for aggregators — structured, complete, and far more reliable than scraping.
        &ldquo;careers-page&rdquo; is a real crawl, for companies that host their own.
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
        <table style={{ marginTop: '.9rem' }}>
          <tbody>
            {companies.map((c) => (
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
      )}
    </div>
  );
}
