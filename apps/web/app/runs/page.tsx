'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { AllQuestions } from '../../components/AllQuestions';
import { Icon } from '../../components/Icon';
import { Pager } from '../discover/components/Pager';

interface AppRow {
  id: string;
  status: string;
  blockedReason: string | null;
  submittedAt: string | null;
  requiresReview: boolean;
  createdAt: string;
  job: { url: string; company: string; title: string; ats: string };
  _count: { pending: number };
}

/** Status tabs. "Needs you" overlaps the others on purpose: it is a to-do list, not a state. */
const BUCKETS = [
  { key: 'ALL', label: 'All', test: () => true },
  { key: 'NEEDS_YOU', label: 'Needs you', test: needsYou },
  { key: 'IN_PROGRESS', label: 'In progress', test: (r: AppRow) => ['QUEUED', 'PREPARING', 'FILLING', 'SUBMITTING'].includes(r.status) },
  { key: 'SUBMITTED', label: 'Submitted', test: (r: AppRow) => r.status === 'SUBMITTED' },
  { key: 'FAILED', label: 'Failed', test: (r: AppRow) => r.status === 'FAILED' },
  { key: 'CANCELLED', label: 'Cancelled', test: (r: AppRow) => r.status === 'CANCELLED' },
] as const;
type Bucket = (typeof BUCKETS)[number]['key'];

/** Started within the last N days; 0 means since midnight today. */
const SINCE = [
  { value: '', label: 'Any time' },
  { value: '0', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];
const PAGE_SIZE = 25;

function sinceCutoff(days: string): number {
  if (!days) return 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - Number(days));
  return d.getTime();
}

export default function RunsPage() {
  const [rows, setRows] = useState<AppRow[]>([]);
  // Runs this server is driving right now, parked ones included.
  const [active, setActive] = useState<string[]>([]);
  const [url, setUrl] = useState('');
  const [review, setReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>('ALL');
  const [query, setQuery] = useState('');
  const [ats, setAts] = useState('');
  const [since, setSince] = useState('');
  const [page, setPage] = useState(1);
  // Any filter change goes back to the first page; polling does not.
  useEffect(() => setPage(1), [bucket, query, ats, since]);

  const atsOptions = [...new Set(rows.map((r) => r.job.ats))].sort();
  const q = query.trim().toLowerCase();
  const cutoff = sinceCutoff(since);
  // Search, ATS and date narrow first so the tab counts say what each tab would show.
  const narrowed = rows.filter(
    (r) =>
      (!ats || r.job.ats === ats) &&
      (!cutoff || new Date(r.createdAt).getTime() >= cutoff) &&
      (!q || [r.job.title, r.job.company, r.job.url].some((s) => s.toLowerCase().includes(q))),
  );
  const shown = sortNeedsYouFirst(narrowed.filter(BUCKETS.find((b) => b.key === bucket)!.test));
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  // A run leaving the list can shrink it under the current page; clamp rather than show nothing.
  const current = Math.min(page, pages);
  const pageRows = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const filtering = bucket !== 'ALL' || q !== '' || ats !== '' || since !== '';

  /** Start a failed run again. Answers already given are kept and reused. */
  async function retry(id: string) {
    setRetrying(id);
    setError(null);
    try {
      await api(`/api/applications/${id}/start`, { method: 'POST' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying(null);
    }
  }
  async function markSubmitted(r: AppRow) {
    const name = r.job.title === 'pending' ? r.job.url : `${r.job.title} at ${r.job.company}`;
    if (!window.confirm(`Mark ${name} as submitted?`)) return;
    setError(null);
    try {
      await api(`/api/applications/${r.id}/outcome`, {
        method: 'POST',
        body: JSON.stringify({ submitted: true }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{ llmConfigured: boolean; headless: boolean } | null>(null);

  const load = () =>
    api<{ applications: AppRow[]; active?: string[] }>('/api/applications')
      .then((d) => {
        setRows(d.applications);
        setActive(d.active ?? []);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    api<typeof health>('/api/system').then(setHealth).catch(() => {});
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ applicationId: string }>('/api/applications', {
        method: 'POST',
        body: JSON.stringify({ url, autoStart: true, requiresReview: review }),
      });
      setUrl('');
      window.location.href = `/applications/${r.applicationId}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {health && !health.llmConfigured && (
        <div className="notice warn" style={{ marginBottom: '1rem' }}>
          <div className="spread" style={{ width: '100%' }}>
            <span>
              <strong>No model key set.</strong> Field matching and the answer bank still work, but
              cover letters and inference will fail.
            </span>
            <a href="/settings" className="btn small">
              Add a key
            </a>
          </div>
        </div>
      )}
      {health?.headless && (
        <div className="notice" style={{ marginBottom: '1rem' }}>
          Running headless. Set <code>HEADLESS=false</code> so you can see the form, take over on a
          captcha, and give the browser profile a real interaction history.
        </div>
      )}

      <div className="panel">
        <h2>Apply to a job</h2>
        <p className="sub">
          Paste the posting URL. Greenhouse, Lever, Ashby and Workable have dedicated handling;
          anything else falls back to reading the form off the page.
        </p>
        <form onSubmit={add}>
          <div className="row">
            <input
              type="url"
              required
              placeholder="https://job-boards.greenhouse.io/acme/jobs/1234567"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              style={{ flex: 1, minWidth: '18rem' }}
            />
            <button className="primary" disabled={busy}>
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
          <label className="row small" style={{ marginTop: '.7rem' }}>
            <input
              type="checkbox"
              checked={review}
              onChange={(e) => setReview(e.target.checked)}
              style={{ width: 'auto' }}
            />
            <span>Stop for my review before submitting</span>
          </label>
        </form>
        {error && <p className="notice bad" style={{ marginTop: '.8rem' }}>{error}</p>}
      </div>

      <div className="panel">
        <div className="spread">
          <h2>Applications</h2>
          {rows.some((r) => r._count.pending > 0 && !['SUBMITTED', 'CANCELLED'].includes(r.status)) && (
            <button className="primary" onClick={() => setAsking(true)}>
              Answer all questions
            </button>
          )}
        </div>
        {asking && <AllQuestions onClose={() => { setAsking(false); load(); }} />}
        {rows.length > 0 && (
          <div className="stack" style={{ margin: '.8rem 0' }}>
            <div className="tabs" role="tablist" aria-label="Application status">
              {BUCKETS.map((b) => {
                const n = narrowed.filter(b.test).length;
                return (
                  <button key={b.key} role="tab" aria-selected={bucket === b.key} onClick={() => setBucket(b.key)}>
                    {b.label}
                    {n ? <span className="muted nums"> {n}</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="toolbar">
              <label className="field grow">
                <span className="cap">Search</span>
                <input
                  type="search"
                  placeholder="Role, company or URL"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="cap">ATS</span>
                <select value={ats} onChange={(e) => setAts(e.target.value)}>
                  <option value="">All</option>
                  {atsOptions.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="cap">Started</span>
                <select value={since} onChange={(e) => setSince(e.target.value)}>
                  {SINCE.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </label>
              {filtering && (
                <button
                  className="ghost"
                  onClick={() => {
                    setBucket('ALL');
                    setQuery('');
                    setAts('');
                    setSince('');
                  }}
                >
                  Clear
                </button>
              )}
              <span className="toolbar-note">
                {shown.length} of {rows.length}
              </span>
            </div>
          </div>
        )}
        {rows.length === 0 ? (
          <div className="empty-state">Nothing yet. Paste a job URL above to start one.</div>
        ) : shown.length === 0 ? (
          <div className="empty-state">No applications match these filters.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Status</th>
                <th>Needs you</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr
                  key={r.id}
                  // The whole row opens the run; the links inside still work on their own.
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest('a, button')) window.location.href = `/applications/${r.id}`;
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={{ overflowWrap: 'anywhere' }}>
                    <a href={`/applications/${r.id}`} title="Open this run">
                      {r.job.title === 'pending' ? r.job.url : `${r.job.title} — ${r.job.company}`}
                    </a>{' '}
                    <a href={r.job.url} target="_blank" rel="noreferrer" className="small muted" title="The job posting">
                      posting
                    </a>
                    {r.blockedReason && (
                      <div
                        className="muted small"
                        title={r.blockedReason}
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {shortReason(r.blockedReason)}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="row" style={{ gap: '.4rem', flexWrap: 'nowrap' }}>
                      <span className={`pill ${r.status}`}>{r.status.replace('_', ' ')}</span>
                      {canRetry(r, active) && (
                        <button
                          className="ghost small"
                          disabled={retrying !== null}
                          onClick={() => retry(r.id)}
                          title={
                            r.requiresReview
                              ? 'Retry this application. It stops for your review before submitting.'
                              : 'Retry this application. Auto-apply is on for it: it submits without asking.'
                          }
                          aria-label="Retry"
                        >
                          <Icon name="refresh" size={14} className={retrying === r.id ? 'spin' : undefined} />
                        </button>
                      )}
                      {r.status !== 'SUBMITTED' && (
                        <button
                          className="ghost small"
                          onClick={() => markSubmitted(r)}
                          title="Mark as submitted (you applied yourself)"
                          aria-label="Mark as submitted"
                        >
                          <Icon name="check" size={14} />
                        </button>
                      )}
                    </span>
                  </td>
                  <td className="small">
                    {r._count.pending > 0 ? (
                      <span style={{ color: 'var(--warn)', fontWeight: 600 }}>
                        {r._count.pending} question{r._count.pending === 1 ? '' : 's'}
                      </span>
                    ) : r.status === 'REVIEW' ? (
                      <span style={{ color: 'var(--warn)', fontWeight: 600 }}>approval</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="small muted nums" title={new Date(r.createdAt).toLocaleString()}>
                    {new Date(r.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pager page={current} pages={pages} total={shown.length} limit={PAGE_SIZE} shown={pageRows.length} onPage={setPage} />
      </div>
    </>
  );
}

/**
 * Stopped and nothing is driving it: failed, or "needs you" from a run that is
 * no longer alive (a restart, a closed tab). A NEEDS_HUMAN run that is still
 * active is waiting at a wall in an open browser - starting it again there
 * would race the live one, so it gets no button. Nor does one whose submit
 * may already have landed: a duplicate application is worse than a stalled one.
 */
function canRetry(r: AppRow, active: string[]): boolean {
  if (r.status === 'FAILED') return true;
  if (r.status !== 'NEEDS_HUMAN' || active.includes(r.id)) return false;
  // Submit may already have gone through: check the job board, never resend blind.
  return !/Submit was pressed|mid-submit/i.test(r.blockedReason ?? '');
}

/** Waiting on you: approval, open questions, or a wall only a person can get past. */
function needsYou(r: AppRow): boolean {
  if (['REVIEW', 'NEEDS_HUMAN', 'NEEDS_INPUT'].includes(r.status)) return true;
  return r._count.pending > 0 && !['SUBMITTED', 'CANCELLED'].includes(r.status);
}

/**
 * Runs waiting on you go first: filled and awaiting approval, then ones with
 * open questions. Everything else keeps the server's order (stable sort).
 */
function sortNeedsYouFirst(rows: AppRow[]): AppRow[] {
  const rank = (r: AppRow) =>
    r.status === 'REVIEW' ? 0 : r._count.pending > 0 && !['SUBMITTED', 'CANCELLED'].includes(r.status) ? 1 : 2;
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/**
 * Playwright errors carry the whole browser launch log after the message.
 * Show only the message; the full text stays in the tooltip and the run log.
 */
function shortReason(reason: string): string {
  return reason.split(/\s(?:Browser logs:|Call log:|=+ logs =+)/)[0]!.trim();
}
