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

interface SearchReport {
  planSource: 'model' | 'profile';
  roleTitles: string[];
  queries: { query: string; hits: number }[];
  creditsUsed: number;
  boards: { ats: string; slug: string; company: string; openings: number; kept: number; error?: string }[];
  jobsSeen: number;
  newLeads: number;
  skippedAlreadySeen: number;
  deepScored: number;
  companiesRegistered: number;
  notes: string[];
  errors: { where: string; error: string }[];
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
  const [searchConfigured, setSearchConfigured] = useState(true);
  const [report, setReport] = useState<SearchReport | null>(null);
  const [filter, setFilter] = useState('NEW');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Lead | null>(null);
  // Keyed by lead. An error from a card has to appear on that card: the shared
  // banner at the top of the page is often a screen away from the button that
  // was pressed, which makes a failed click look like a dead button.
  const [leadErrors, setLeadErrors] = useState<Record<string, string>>({});

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
    api<{
      sources: { id: string; handleHint: string }[];
      rejectCategories: string[];
      searchConfigured: boolean;
    }>('/api/sources')
      .then((d) => {
        setSources(d.sources);
        setCategories(d.rejectCategories);
        setSearchConfigured(d.searchConfigured);
      })
      .catch(() => {});
  }, [load]);

  async function find(dryRun = false) {
    setBusy(dryRun ? 'preview' : 'find');
    setError(null);
    setFlash(null);
    setReport(null);
    try {
      const r = await api<{ report: SearchReport }>('/api/discovery/find', {
        method: 'POST',
        body: JSON.stringify({ deepScoreTop: 15, dryRun }),
      });
      setReport(r.report);
      if (!dryRun) await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function crawl() {
    if (!companies.length) {
      setError(
        'No boards on the watch list yet, so there is nothing to re-check. Press "Find jobs for ' +
          'me" — it adds every company it finds — or add one by hand below.',
      );
      return;
    }
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
    setLeadErrors((prev) => {
      const next = { ...prev };
      delete next[lead.id];
      return next;
    });
    try {
      if (action === 'apply') {
        const r = await api<{ applicationId: string }>(`/api/leads/${lead.id}/apply`, { method: 'POST' });
        window.location.href = `/applications/${r.applicationId}`;
        return;
      }
      await api(`/api/leads/${lead.id}/shortlist`, { method: 'POST' });
      await load();
    } catch (e) {
      setLeadErrors((prev) => ({ ...prev, [lead.id]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  // The split that makes the page useful: the jobs worth opening, then the
  // rest. 70 is the same threshold the score turns green at, so the section
  // heading and the number beside each job never disagree.
  const strong = filter === 'NEW' ? leads.filter((l) => l.score >= 70) : [];
  const rest = filter === 'NEW' ? leads.filter((l) => l.score < 70) : leads;
  const failing = companies.filter((c) => c.lastCrawlNote?.startsWith('failed')).length;

  return (
    <>
      <div className="panel">
        <div className="spread">
          <div style={{ minWidth: 0 }}>
            <h2>Find work</h2>
            <p className="sub" style={{ margin: 0, maxWidth: '46rem' }}>
              Reads your resume, works out what to search for, and goes looking — you do not have
              to name companies. Every posting it finds is on a board it can actually submit an
              application to, scored against your profile and your past decisions.
            </p>
          </div>
          <div className="row" style={{ flex: 'none', gap: '.5rem' }}>
            {/*
              Deliberately not disabled when there is no key. A greyed-out
              button that does nothing when you click it is indistinguishable
              from a broken one; clicking this always produces an answer, even
              if the answer is which line to add to .env.
            */}
            <button
              className="primary"
              disabled={busy !== null}
              onClick={() => find(false)}
              title="Search the web for openings that match your profile"
            >
              {busy === 'find' ? 'Searching…' : 'Find jobs for me'}
            </button>
            <button
              disabled={busy !== null}
              onClick={() => find(true)}
              title="Show the searches it would run. Costs nothing and needs no key."
            >
              {busy === 'preview' ? 'Working…' : 'Preview'}
            </button>
            <button
              disabled={busy !== null}
              onClick={crawl}
              title="Re-read the boards already on the list, without searching"
            >
              {busy === 'crawl' ? 'Re-checking…' : 'Re-check known boards'}
            </button>
          </div>
        </div>

        {!searchConfigured && (
          <div className="notice" style={{ marginTop: '.9rem' }}>
            Searching needs a free Firecrawl key. Put <code>FIRECRAWL_API_KEY</code> in{' '}
            <code>.env</code> and restart the server — get one at{' '}
            <a href="https://firecrawl.dev" target="_blank" rel="noreferrer">
              firecrawl.dev
            </a>
            . <strong>Preview</strong> works without one and shows you what it would search for.
            You can also add boards by hand below, or paste a job URL on the Runs page.
          </div>
        )}
        <Tally counts={counts} strong={strong.length} />

        {flash && <div className="notice good" style={{ marginTop: '.9rem' }}>{flash}</div>}
        {error && <div className="notice bad" style={{ marginTop: '.9rem' }}>{error}</div>}
        {report && <SearchReportPanel report={report} />}
      </div>

      {filter === 'NEW' && strong.length > 0 && (
        <div className="panel">
          <h2>Strong matches</h2>
          <p className="sub">
            Scored 70 or above against your profile and your past decisions. Start here.
          </p>
          {strong.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              busy={busy === lead.id}
              error={leadErrors[lead.id]}
              onApply={() => decide(lead, 'apply')}
              onShortlist={() => decide(lead, 'shortlist')}
              onReject={() => setRejecting(lead)}
            />
          ))}
        </div>
      )}

      <div className="panel">
        <div className="spread">
          <h2>{filter === 'NEW' && strong.length > 0 ? 'Everything else' : 'Jobs'}</h2>
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

        {rest.length === 0 ? (
          <p className="muted small" style={{ marginTop: '.8rem' }}>
            {leads.length === 0
              ? 'No jobs here yet. Press “Find jobs for me” above.'
              : 'Everything here is in strong matches.'}
          </p>
        ) : (
          rest.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              busy={busy === lead.id}
              error={leadErrors[lead.id]}
              onApply={() => decide(lead, 'apply')}
              onShortlist={() => decide(lead, 'shortlist')}
              onReject={() => setRejecting(lead)}
            />
          ))
        )}
      </div>

      <details className="panel">
        <summary style={{ cursor: 'pointer' }}>
          <strong>Sources</strong>{' '}
          <span className="muted small">
            — {companies.length} board{companies.length === 1 ? '' : 's'} watched
            {failing > 0 && `, ${failing} failing`}
          </span>
        </summary>
        <CompanyManager companies={companies} sources={sources} onChange={load} />
      </details>

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
  error,
  onApply,
  onShortlist,
  onReject,
}: {
  lead: Lead;
  busy: boolean;
  error?: string;
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
            <a href={`/jobs/${lead.id}`}>
              <strong>{lead.title}</strong>
            </a>
            <span className="muted small">· {lead.companyName}</span>
            <a
              href={lead.url}
              target="_blank"
              rel="noreferrer"
              className="small muted"
              title="Open the original posting"
            >
              ↗
            </a>
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

        <div className="row" style={{ flexWrap: 'nowrap', flex: 'none' }}>
          <a href={`/jobs/${lead.id}`}>
            <button title="Everything about this job on one page">View job</button>
          </a>
          {lead.status === 'NEW' ? (
            <>
              <button className="primary" disabled={busy} onClick={onApply}>
                Apply
              </button>
              <button disabled={busy} onClick={onShortlist}>
                Save
              </button>
              <button className="danger" disabled={busy} onClick={onReject}>
                Not for me
              </button>
            </>
          ) : (
            <span className={`pill ${lead.status}`}>{lead.status}</span>
          )}
        </div>
      </div>

      {error && (
        <div className="notice bad" style={{ marginTop: '.5rem' }}>
          {error}
        </div>
      )}

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

/**
 * The numbers, before any of the machinery.
 *
 * Someone opening this page wants to know what was found for them, not how
 * many boards were read or which one errored. Those still matter and are still
 * on the page — one fold down, under Sources, where they belong.
 */
function Tally({ counts, strong }: { counts: Record<string, number>; strong: number }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const cells: [number, string, string | undefined][] = [
    [counts.NEW ?? 0, 'new jobs found', undefined],
    [strong, 'strong matches', strong > 0 ? 'var(--good)' : undefined],
    [counts.SHORTLISTED ?? 0, 'worth applying', undefined],
    [counts.APPLIED ?? 0, 'applied', undefined],
    [counts.REJECTED ?? 0, 'rejected', undefined],
  ];
  return (
    <div className="row" style={{ gap: '2rem', marginTop: '1rem', flexWrap: 'wrap' }}>
      {cells.map(([value, label, tone]) => (
        <div key={label}>
          <div
            style={{
              fontSize: '1.6rem',
              fontWeight: 650,
              lineHeight: 1.1,
              fontVariantNumeric: 'tabular-nums',
              color: tone ?? 'inherit',
            }}
          >
            {value}
          </div>
          <div className="muted small">{label}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * What the run actually did.
 *
 * A single "found 12 jobs" line hides the two things worth knowing: what it
 * searched for on your behalf, and which companies it turned up. Both are
 * shown, because the searches are the part you will want to correct — and the
 * way to correct them is to reject a few leads, which the queue below makes
 * one click.
 */
function SearchReportPanel({ report }: { report: SearchReport }) {
  const boards = report.boards.filter((b) => b.kept > 0);
  const nothing = report.newLeads === 0;
  const dryRun = report.notes.some((n) => n.startsWith('Dry run:'));

  return (
    <div className="notice" style={{ marginTop: '.9rem' }}>
      <strong>
        {dryRun
          ? `Would run ${report.queries.length} search${report.queries.length === 1 ? '' : 'es'}.`
          : nothing
            ? 'No new jobs this time.'
            : `${report.newLeads} new job${report.newLeads === 1 ? '' : 's'} from ${boards.length} compan${
                boards.length === 1 ? 'y' : 'ies'
              }.`}
      </strong>{' '}
      {!dryRun && (
        <span className="muted small">
          Searched {report.queries.length} time{report.queries.length === 1 ? '' : 's'} ·{' '}
          {report.jobsSeen} posting{report.jobsSeen === 1 ? '' : 's'} considered ·{' '}
          {report.skippedAlreadySeen} already seen · {report.deepScored} read in full
          {report.companiesRegistered > 0 &&
            ` · ${report.companiesRegistered} new board${
              report.companiesRegistered === 1 ? '' : 's'
            } added to the watch list`}
          {report.creditsUsed > 0 && ` · ${report.creditsUsed} search credits`}
        </span>
      )}

      <details open={dryRun} style={{ marginTop: '.6rem' }}>
        <summary className="small" style={{ cursor: 'pointer' }}>
          {dryRun ? 'The searches it would run' : 'What it searched for'}
          {report.planSource === 'profile' && ' (derived from your profile, no model used)'}
        </summary>
        <ul className="small muted" style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
          {report.queries.map((q) => (
            <li key={q.query}>
              &ldquo;{q.query}&rdquo;
              {!dryRun && ` — ${q.hits} usable hit${q.hits === 1 ? '' : 's'}`}
            </li>
          ))}
        </ul>
        {report.roleTitles.length > 0 && (
          <p className="small muted" style={{ margin: '.5rem 0 0' }}>
            Kept other openings at those companies matching:{' '}
            {report.roleTitles.map((t) => `“${t}”`).join(', ')}. Reject a few below and the next
            search narrows.
          </p>
        )}
      </details>

      {boards.length > 0 && (
        <details style={{ marginTop: '.35rem' }}>
          <summary className="small" style={{ cursor: 'pointer' }}>
            Companies it found
          </summary>
          <ul className="small muted" style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
            {boards.map((b) => (
              <li key={`${b.ats}:${b.slug}`}>
                {b.company} <span className="src">{b.ats}</span> — {b.kept} of {b.openings} opening
                {b.openings === 1 ? '' : 's'} kept
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.notes.map((n) => (
        <p key={n} className="small muted" style={{ margin: '.4rem 0 0' }}>
          {n}
        </p>
      ))}
      {report.errors.map((e) => (
        <p key={e.where} className="small" style={{ margin: '.4rem 0 0', color: 'var(--bad)' }}>
          {e.where}: {e.error}
        </p>
      ))}
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
