'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { RejectDialog } from '../../components/RejectDialog';

interface JobLead {
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
    affinity?: number;
    sharedTerms?: string[];
    missingTerms?: string[];
  } | null;
  status: string;
}

interface LeadPage {
  leads: JobLead[];
  counts: Record<string, number>;
  total: number;
  page: number;
  pages: number;
  limit: number;
  strong: number;
  maxRescoreBatch: number;
}

/** Everything that decides which jobs are on screen and in what order. */
interface View {
  status: string;
  sort: 'score' | 'discovered' | 'company' | 'title';
  dir: 'desc' | 'asc';
  q: string;
  remote: 'any' | 'yes' | 'no';
  minScore: string;
  depth: 'any' | 'deep' | 'quick';
  limit: number;
  country: string;
}

const DEFAULT_VIEW: View = {
  status: 'NEW',
  sort: 'score',
  dir: 'desc',
  q: '',
  remote: 'any',
  minScore: '',
  depth: 'any',
  limit: 25,
  country: '',
};

function queryString(view: View, page: number): string {
  const params = new URLSearchParams({
    status: view.status,
    sort: view.sort,
    dir: view.dir,
    remote: view.remote,
    depth: view.depth,
    limit: String(view.limit),
    page: String(page),
  });
  if (view.q) params.set('q', view.q);
  if (view.minScore) params.set('minScore', view.minScore);
  if (view.country) params.set('country', view.country);
  return params.toString();
}

interface RescoreResult {
  id: string;
  ok: boolean;
  score?: number;
  error?: string;
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
  rerankedExisting: number;
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
  const [leads, setLeads] = useState<JobLead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sources, setSources] = useState<{ id: string; handleHint: string }[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [searchConfigured, setSearchConfigured] = useState(true);
  const [report, setReport] = useState<SearchReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<JobLead | null>(null);
  const [cleanupDialog, setCleanupDialog] = useState(false);
  // Keyed by lead. An error from a card has to appear on that card: the shared
  // banner at the top of the page is often a screen away from the button that
  // was pressed, which makes a failed click look like a dead button.
  const [leadErrors, setLeadErrors] = useState<Record<string, string>>({});

  // Which page of which slice of the queue is on screen.
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ total: 0, pages: 1, strong: 0, maxRescoreBatch: 25 });

  // Typed straight into the box; `view.q` lags it by a beat so a search does
  // not fire a request per keystroke.
  const [typed, setTyped] = useState('');

  // Ticked leads, by id. Kept across pages on purpose: picking three from this
  // page and two from the next, then rescoring all five, is the point.
  const [picked, setPicked] = useState<string[]>([]);

  /**
   * Whether Apply should write a cover letter.
   *
   * Off by default and remembered in this browser. Most applications do not
   * need one, and writing one for every job spends a model call and half a
   * minute on something nobody reads - but when you are applying somewhere you
   * actually care about, you want it, and you do not want to hunt for the
   * setting each time. A form that requires one always gets one regardless.
   */
  const [writeCoverLetter, setWriteCoverLetter] = useState(false);
  useEffect(() => {
    try {
      setWriteCoverLetter(window.localStorage.getItem('ja.coverLetter') === 'on');
    } catch {
      // Private windows and blocked site data both throw here; the default stands.
    }
  }, []);

  useEffect(() => {
    if (typed === view.q) return;
    const t = setTimeout(() => change({ q: typed }), 300);
    return () => clearTimeout(t);
    // `change` is stable enough for this: it only closes over setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, view.q]);

  const load = useCallback(async () => {
    const [l, c] = await Promise.all([
      api<LeadPage>(`/api/leads?${queryString(view, page)}`),
      api<{ companies: Company[] }>('/api/companies'),
    ]);
    setLeads(l.leads);
    setCounts(l.counts);
    setCompanies(c.companies);
    setPageInfo({
      total: l.total,
      pages: l.pages,
      strong: l.strong,
      maxRescoreBatch: l.maxRescoreBatch,
    });
    // The server clamps a page past the end, so follow it rather than sitting
    // on a number that no longer exists.
    if (l.page !== page) setPage(l.page);
  }, [view, page]);

  /** Any change to what is being shown starts again at page one. */
  function change(patch: Partial<View>) {
    setView((v) => ({ ...v, ...patch }));
    setPage(1);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
    api('/api/sources')
      .then((d) => {
        const dd = d as { sources: { id: string; handleHint: string }[]; rejectCategories: string[]; searchConfigured: boolean };
        setSources(dd.sources);
        setCategories(dd.rejectCategories);
        setSearchConfigured(dd.searchConfigured);
      })
      .catch(() => {});
  }, [load]);

  async function find(dryRun = false) {
    setBusy(dryRun ? 'preview' : 'find');
    setError(null);
    setFlash(null);
    setReport(null);
    try {
      const rRaw = await api('/api/discovery/find', {
        method: 'POST',
        body: JSON.stringify({ deepScoreTop: 15, dryRun, country: view.country || undefined }),
      });
      const r = rRaw as { report: SearchReport };
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
      const crawlRaw = await api('/api/discovery/crawl', { method: 'POST', body: JSON.stringify({ deepScoreTop: 15, country: view.country || undefined }) });
      const { report } = crawlRaw as { report: Record<string, number | unknown[]> };
      const errs = (report.errors as { company: string; error: string }[]) ?? [];
      setFlash(
        `Crawled ${report.companiesCrawled} boards, saw ${report.jobsSeen} postings, ${report.newLeads} new. ` +
          `${report.deepScored} read in full. ${report.rerankedExisting} already in the queue re-ranked.` +
          (errs.length ? ` ${errs.length} board(s) failed: ${errs.map((e) => e.company).join(', ')}.` : ''),
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function decide(lead: JobLead, action: 'apply' | 'shortlist' | 'applied') {
    setBusy(lead.id);
    setLeadErrors((prev) => {
      const next = { ...prev };
      delete next[lead.id];
      return next;
    });
    try {
      if (action === 'apply') {
        const rRaw = await api(`/api/leads/${lead.id}/apply`, {
          method: 'POST',
          body: JSON.stringify({ writeCoverLetter, autoTailorResume: true }),
        });
        const r = rRaw as { applicationId: string; tailoredResumeId?: string };
        window.location.href = `/applications/${r.applicationId}`;
        return;
      }
      await api(`/api/leads/${lead.id}/${action === 'applied' ? 'applied' : 'shortlist'}`, {
        method: 'POST',
      });
      if (action === 'applied') {
        setFlash(
          `Marked "${lead.title}" as applied. It is in the tracker now, and out of the queue.`,
        );
      }
      await load();
    } catch (e) {
      setLeadErrors((prev) => ({ ...prev, [lead.id]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  function togglePicked(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  /**
   * Read the ticked postings properly.
   *
   * Deliberately not "rescore everything". A model pass is seconds and a
   * fraction of a cent per posting, and most of a queue is jobs you have
   * already glanced at and dismissed - so the button spends what you pointed
   * it at, and nothing else.
   */
  async function rescorePicked() {
    const batch = picked.slice(0, pageInfo.maxRescoreBatch);
    if (!batch.length) return;
    setBusy('rescore');
    setError(null);
    setFlash(null);
    setLeadErrors({});
    try {
      const r = await api<{ results: RescoreResult[]; rescored: number }>('/api/leads/rescore', {
        method: 'POST',
        body: JSON.stringify({ ids: batch }),
      });
      const failed = r.results.filter((x) => !x.ok);
      setLeadErrors(Object.fromEntries(failed.map((x) => [x.id, x.error ?? 'Could not read it.'])));
      setFlash(
        `Read ${r.rescored} posting${r.rescored === 1 ? '' : 's'} in full and re-scored ${
          r.rescored === 1 ? 'it' : 'them'
        }.` + (failed.length ? ` ${failed.length} could not be read — see the rows below.` : ''),
      );
      // Keep the ones that failed ticked, so a retry is one press. Drop the
      // ones that worked: their new score is on screen.
      setPicked(failed.map((x) => x.id));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function rescoreAll() {
    setBusy('rescore-all');
    setError(null);
    setFlash(null);
    setLeadErrors({});
    try {
      const r = await api<{ results: RescoreResult[]; rescored: number; failed: number; message: string }>('/api/leads/rescore-all', {
        method: 'POST',
        body: JSON.stringify({ status: view.status, limit: 50 }),
      });
      setFlash(r.message);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // The split that makes the page useful: the jobs worth opening, then the
  // rest. 70 is the same threshold the score turns green at, so the section
  // heading and the number beside each job never disagree.
  //
  // Only when the page is actually ordered by score, though. Grouping a
  // title-sorted page under "Strong matches" would scatter the two headings
  // through an alphabetical list and say nothing true about either.
  const grouped = view.status === 'NEW' && view.sort === 'score' && view.dir === 'desc';
  const strong = grouped ? leads.filter((l) => l.score >= 70) : [];
  const rest = grouped ? leads.filter((l) => l.score < 70) : leads;
  const failing = companies.filter((c) => c.lastCrawlNote?.startsWith('failed')).length;
  const pageIds = leads.map((l) => l.id);
  const allPicked = pageIds.length > 0 && pageIds.every((id) => picked.includes(id));

  const cardProps = (lead: JobLead) => ({
    lead,
    busy: busy === lead.id || busy === 'rescore',
    error: leadErrors[lead.id],
    picked: picked.includes(lead.id),
    onPick: () => togglePicked(lead.id),
    onApply: () => decide(lead, 'apply'),
    onShortlist: () => decide(lead, 'shortlist'),
    onApplied: () => decide(lead, 'applied'),
    onReject: () => setRejecting(lead),
  });

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
            <button
              disabled={busy !== null}
              onClick={rescoreAll}
              title="Rescore all jobs using batch processing (fewer LLM calls)"
            >
              {busy === 'rescore-all' ? 'Rescoring…' : 'Rescore all jobs'}
            </button>
            <button
              disabled={busy !== null}
              onClick={() => setCleanupDialog(true)}
              title="Clean up old or low-scoring leads"
            >
              Cleanup
            </button>
          </div>
        </div>

        {!searchConfigured && (
          <div className="notice" style={{ marginTop: '.9rem' }}>
            Searching needs a free Firecrawl key. Add it on the{' '}
            <a href="/settings" className="link">
              Settings page
            </a>{' '}
            — get one at{' '}
            <a href="https://firecrawl.dev" target="_blank" rel="noreferrer">
              firecrawl.dev
            </a>
            . <strong>Preview</strong> works without one and shows you what it would search for.
            You can also add boards by hand below, or paste a job URL on the Runs page.
          </div>
        )}
        <Tally counts={counts} strong={pageInfo.strong} />

        {flash && <div className="notice good" style={{ marginTop: '.9rem' }}>{flash}</div>}
        {error && <div className="notice bad" style={{ marginTop: '.9rem' }}>{error}</div>}
        {report && <SearchReportPanel report={report} />}
      </div>

      {grouped && strong.length > 0 && (
        <div className="panel">
          <h2>Strong matches</h2>
          <p className="sub">
            Scored 70 or above against your profile and your past decisions. Start here.
          </p>
          {strong.map((lead) => (
            <LeadCard key={lead.id} {...cardProps(lead)} />
          ))}
        </div>
      )}

      <div className="panel">
        <div className="spread">
          <h2>{grouped && strong.length > 0 ? 'Everything else' : 'Jobs'}</h2>
          <div className="row">
            {['NEW', 'SHORTLISTED', 'APPLIED', 'REJECTED', 'ALL'].map((s) => (
              <button
                key={s}
                className={view.status === s ? undefined : 'ghost'}
                onClick={() => change({ status: s })}
                style={
                  view.status === s
                    ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--accent)' }
                    : undefined
                }
              >
                {s.toLowerCase()} {counts[s] !== undefined ? `(${counts[s]})` : ''}
              </button>
            ))}
          </div>
        </div>

        <Controls
          view={view}
          typed={typed}
          onTyped={setTyped}
          onChange={change}
          total={pageInfo.total}
        />

        <label
          className="row small muted"
          style={{ gap: '.4rem', marginTop: '.6rem', alignItems: 'center' }}
        >
          <input
            type="checkbox"
            checked={writeCoverLetter}
            onChange={(e) => {
              setWriteCoverLetter(e.target.checked);
              try {
                window.localStorage.setItem('ja.coverLetter', e.target.checked ? 'on' : 'off');
              } catch {
                // Not being able to remember it is not a reason to refuse the change.
              }
            }}
          />
          Write a cover letter when I press Apply
          <span className="muted">
            — off by default. A form that requires one gets one either way.
          </span>
        </label>

        <SelectionBar
          picked={picked}
          max={pageInfo.maxRescoreBatch}
          allPicked={allPicked}
          pageCount={pageIds.length}
          busy={busy === 'rescore'}
          onToggleAll={() =>
            setPicked((p) =>
              allPicked ? p.filter((id) => !pageIds.includes(id)) : [...new Set([...p, ...pageIds])],
            )
          }
          onClear={() => setPicked([])}
          onRescore={rescorePicked}
          onRescoreAll={rescoreAll}
          rescoreAllBusy={busy === 'rescore-all'}
        />

        {rest.length === 0 ? (
          <p className="muted small" style={{ marginTop: '.8rem' }}>
            {pageInfo.total === 0
              ? view.q || view.minScore || view.remote !== 'any' || view.depth !== 'any' || view.country !== ''
                ? 'Nothing matches those filters. Widen them, or clear them.'
                : 'No jobs here yet. Press “Find jobs for me” above.'
              : 'Everything on this page is in strong matches.'}
          </p>
        ) : (
          rest.map((lead) => <LeadCard key={lead.id} {...cardProps(lead)} />)
        )}

        <Pager
          page={page}
          pages={pageInfo.pages}
          total={pageInfo.total}
          limit={view.limit}
          shown={leads.length}
          onPage={setPage}
        />
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

      {cleanupDialog && (
        <CleanupDialog
          onClose={() => setCleanupDialog(false)}
          onDone={async (msg: string) => {
            setCleanupDialog(false);
            setFlash(msg);
            await load();
          }}
        />
      )}
    </>
  );
}

function CleanupDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [olderThanDays, setOlderThanDays] = useState(20);
  const [status, setStatus] = useState<'ALL' | 'NEW' | 'SHORTLISTED' | 'REJECTED' | 'APPLIED' | 'EXPIRED'>('ALL');
  const [maxScore, setMaxScore] = useState<number>(40);
  const [quickScoreOnly, setQuickScoreOnly] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [preview, setPreview] = useState<{ deleted: number; byStatus: Record<string, number>; samples: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function handlePreview() {
    setBusy(true);
    try {
      const result = await api<{ deleted: number; byStatus: Record<string, number>; samples: string[] }>('/api/leads/cleanup', {
        method: 'POST',
        body: JSON.stringify({ olderThanDays, status, maxScore, quickScoreOnly, dryRun: true }),
      });
      setPreview(result);
    } catch (e) {
      console.error('Preview failed:', e);
    } finally {
      setBusy(false);
    }
  }

  async function handleCleanup() {
    setBusy(true);
    try {
      const result = await api<{ deleted: number; byStatus: Record<string, number>; samples: string[] }>('/api/leads/cleanup', {
        method: 'POST',
        body: JSON.stringify({ olderThanDays, status, maxScore, quickScoreOnly, dryRun: false }),
      });
      onDone(`Cleaned up ${result.deleted} lead(s).`);
    } catch (e) {
      console.error('Cleanup failed:', e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg)',
          padding: '1.5rem',
          borderRadius: 'var(--radius)',
          maxWidth: '500px',
          width: '90%',
          maxHeight: '80vh',
          overflowY: 'auto',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Cleanup Old Leads</h3>
        <p className="sub" style={{ marginBottom: '1rem' }}>
          Remove old, low-scoring, or otherwise unwanted leads to keep your queue clean.
        </p>

        <div style={{ marginBottom: '1rem' }}>
          <label className="row small muted" style={{ gap: '.35rem', marginBottom: '.5rem' }}>
            Remove leads older than
            <input
              type="number"
              min={1}
              max={365}
              value={olderThanDays}
              onChange={(e) => setOlderThanDays(Number(e.target.value))}
              style={{ width: '4rem' }}
            />
            days
          </label>

          <label className="row small muted" style={{ gap: '.35rem', marginBottom: '.5rem' }}>
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              style={{ flex: 1 }}
            >
              <option value="ALL">All statuses</option>
              <option value="NEW">New</option>
              <option value="SHORTLISTED">Shortlisted</option>
              <option value="REJECTED">Rejected</option>
              <option value="APPLIED">Applied</option>
              <option value="EXPIRED">Expired</option>
            </select>
          </label>

          <label className="row small muted" style={{ gap: '.35rem', marginBottom: '.5rem' }}>
            Max score (below this)
            <input
              type="number"
              min={0}
              max={100}
              value={maxScore}
              onChange={(e) => setMaxScore(Number(e.target.value) || 0)}
              style={{ width: '4rem' }}
            />
          </label>

          <label className="row small muted" style={{ gap: '.35rem', marginBottom: '.5rem' }}>
            <input
              type="checkbox"
              checked={quickScoreOnly}
              onChange={(e) => setQuickScoreOnly(e.target.checked)}
            />
            Only quick-scored leads (not read in full)
          </label>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label className="row small muted" style={{ gap: '.35rem' }}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => {
                setDryRun(e.target.checked);
                setPreview(null);
              }}
            />
            Dry run (preview only, don't delete)
          </label>
        </div>

        {preview && (
          <div style={{ marginBottom: '1rem', padding: '1rem', background: 'var(--panel-2)', borderRadius: 'var(--radius)' }}>
            <p className="small">
              <strong>Preview:</strong> {preview.deleted} lead(s) would be deleted
            </p>
            {Object.keys(preview.byStatus).length > 0 && (
              <p className="small muted">
                By status: {Object.entries(preview.byStatus).map(([s, c]) => `${s}: ${c}`).join(', ')}
              </p>
            )}
            {preview.samples.length > 0 && (
              <div className="small muted" style={{ marginTop: '.5rem' }}>
                <strong>Sample titles:</strong>
                <ul style={{ margin: '.25rem 0 0 1.5rem', paddingLeft: '1rem' }}>
                  {preview.samples.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            onClick={handlePreview}
            disabled={busy || !dryRun}
          >
            {busy ? 'Loading…' : 'Preview'}
          </button>
          {!dryRun && (
            <button
              className="primary"
              onClick={handleCleanup}
              disabled={busy || !preview}
            >
              {busy ? 'Cleaning…' : `Delete ${preview?.deleted ?? 0} leads`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The controls above the list.
 *
 * Laid out flat rather than behind a "Filters" disclosure. A hidden filter is
 * one you forget you left on, and then the page is lying to you about how many
 * jobs you have.
 */
function Controls({
  view,
  typed,
  onTyped,
  onChange,
  total,
}: {
  view: View;
  typed: string;
  onTyped: (v: string) => void;
  onChange: (patch: Partial<View>) => void;
  total: number;
}) {
  const filtered =
    view.q !== '' || view.minScore !== '' || view.remote !== 'any' || view.depth !== 'any' || view.country !== '';

  return (
    <div
      className="row"
      style={{
        marginTop: '.8rem',
        gap: '.6rem',
        alignItems: 'center',
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '.6rem .7rem',
      }}
    >
      <input
        type="search"
        value={typed}
        placeholder="Search title, company or location"
        onChange={(e) => onTyped(e.target.value)}
        style={{ flex: '1 1 14rem', minWidth: '10rem' }}
      />

      <label className="row small muted" style={{ gap: '.35rem' }}>
        sort
        <select
          value={view.sort}
          onChange={(e) => onChange({ sort: e.target.value as View['sort'] })}
        >
          <option value="score">score</option>
          <option value="discovered">when found</option>
          <option value="company">company</option>
          <option value="title">title</option>
        </select>
        <button
          onClick={() => onChange({ dir: view.dir === 'desc' ? 'asc' : 'desc' })}
          title={view.dir === 'desc' ? 'Highest first — click for lowest first' : 'Lowest first — click for highest first'}
        >
          {view.dir === 'desc' ? '↓' : '↑'}
        </button>
      </label>

      <label className="row small muted" style={{ gap: '.35rem' }}>
        remote
        <select
          value={view.remote}
          onChange={(e) => onChange({ remote: e.target.value as View['remote'] })}
        >
          <option value="any">any</option>
          <option value="yes">remote only</option>
          <option value="no">on site</option>
        </select>
      </label>

      <label className="row small muted" style={{ gap: '.35rem' }}>
        country
        <select
          value={view.country}
          onChange={(e) => onChange({ country: e.target.value })}
        >
          <option value="">any</option>
          <option value="US">United States</option>
          <option value="CA">Canada</option>
          <option value="GB">United Kingdom</option>
          <option value="AU">Australia</option>
          <option value="DE">Germany</option>
          <option value="FR">France</option>
          <option value="NL">Netherlands</option>
          <option value="IN">India</option>
          <option value="SG">Singapore</option>
          <option value="AE">United Arab Emirates</option>
        </select>
      </label>

      <label className="row small muted" style={{ gap: '.35rem' }}>
        score ≥
        <input
          type="number"
          min={0}
          max={100}
          value={view.minScore}
          placeholder="0"
          onChange={(e) => onChange({ minScore: e.target.value })}
          style={{ width: '4.5rem' }}
        />
      </label>

      <label className="row small muted" style={{ gap: '.35rem' }}>
        scored
        <select
          value={view.depth}
          onChange={(e) => onChange({ depth: e.target.value as View['depth'] })}
        >
          <option value="any">any way</option>
          <option value="deep">read in full</option>
          <option value="quick">keywords only</option>
        </select>
      </label>

      <label className="row small muted" style={{ gap: '.35rem' }}>
        per page
        <select value={view.limit} onChange={(e) => onChange({ limit: Number(e.target.value) })}>
          {[10, 25, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <span className="muted small">{total} matching</span>
      {filtered && (
        <button
          onClick={() =>
            onChange({ q: '', minScore: '', remote: 'any', depth: 'any', country: '' })
          }
          title="Clear the filters, keep the sort"
        >
          clear filters
        </button>
      )}
    </div>
  );
}

/**
 * "Keywords only" is the state this bar exists for.
 *
 * A crawl reads the top slice properly and ranks the rest on word counts, so
 * most of the queue carries a score nobody stands behind. Ticking the ones
 * that look interesting and pressing this reads exactly those.
 */
function SelectionBar({
  picked,
  max,
  allPicked,
  pageCount,
  busy,
  onToggleAll,
  onClear,
  onRescore,
  onRescoreAll,
  rescoreAllBusy,
}: {
  picked: string[];
  max: number;
  allPicked: boolean;
  pageCount: number;
  busy: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  onRescore: () => void;
  onRescoreAll: () => void;
  rescoreAllBusy: boolean;
}) {
  const over = picked.length > max;
  return (
    <div
      className="row"
      style={{
        gap: '.6rem',
        alignItems: 'center',
        marginTop: '.6rem',
        paddingBottom: '.2rem',
        flexWrap: 'wrap',
      }}
    >
      <label className="row small muted" style={{ gap: '.35rem' }}>
        <input
          type="checkbox"
          checked={allPicked}
          disabled={pageCount === 0}
          onChange={onToggleAll}
        />
        select this page
      </label>

      <button
        className="primary"
        disabled={picked.length === 0 || busy}
        onClick={onRescore}
        title="Send the ticked postings to the model to be read properly"
      >
        {busy
          ? 'Reading…'
          : `Rescore selected${picked.length ? ` (${Math.min(picked.length, max)})` : ''}`}
      </button>

      <button
        disabled={rescoreAllBusy}
        onClick={onRescoreAll}
        title="Rescore all jobs using batch processing (fewer LLM calls)"
      >
        {rescoreAllBusy ? 'Rescoring…' : 'Rescore all jobs'}
      </button>

      {picked.length > 0 && (
        <button onClick={onClear} disabled={busy || rescoreAllBusy}>
          clear selection
        </button>
      )}

      <span className="muted small">
        {picked.length === 0
          ? 'Tick the jobs you want read in full — a real read costs a model call each, so it only reads what you pick.'
          : over
            ? `${picked.length} ticked; the first ${max} will be read. Run it again for the rest.`
            : `${picked.length} ticked, here and on other pages.`}
      </span>
    </div>
  );
}

function Pager({
  page,
  pages,
  total,
  limit,
  shown,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  limit: number;
  shown: number;
  onPage: (p: number) => void;
}) {
  if (total === 0) return null;
  const first = (page - 1) * limit + 1;
  return (
    <div
      className="row"
      style={{ gap: '.5rem', alignItems: 'center', marginTop: '.9rem', borderTop: '1px solid var(--border)', paddingTop: '.8rem' }}
    >
      <button disabled={page <= 1} onClick={() => onPage(1)}>
        « first
      </button>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ previous
      </button>
      <span className="muted small" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {first}–{first + shown - 1} of {total} · page {page} of {pages}
      </span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>
        next ›
      </button>
      <button disabled={page >= pages} onClick={() => onPage(pages)}>
        last »
      </button>
    </div>
  );
}

function LeadCard({
  lead,
  busy,
  error,
  picked,
  onPick,
  onApply,
  onShortlist,
  onApplied,
  onReject,
}: {
  lead: JobLead;
  busy: boolean;
  error?: string;
  picked: boolean;
  onPick: () => void;
  onApply: () => void;
  onShortlist: () => void;
  onApplied: () => void;
  onReject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const r = lead.scoreReasons ?? {};
  const score = Math.round(lead.score);
  const tone = score >= 70 ? 'var(--good)' : score >= 45 ? 'var(--warn)' : 'var(--bad)';
  const toneSoft = score >= 70 ? 'var(--good-soft)' : score >= 45 ? 'var(--warn-soft)' : 'var(--bad-soft)';

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: '.9rem .6rem',
        margin: '0 -.6rem',
        borderRadius: 'var(--radius-sm)',
        transition: 'background var(--fast) var(--ease)',
      }}
      className="lead-row"
    >
      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: '.55rem' }}>
            <input
              type="checkbox"
              checked={picked}
              onChange={onPick}
              title="Pick this one to be read in full"
              aria-label={`Select ${lead.title} at ${lead.companyName}`}
            />
            <span
              style={{
                color: tone,
                background: toneSoft,
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 700,
                fontSize: '.85rem',
                borderRadius: 'var(--radius-sm)',
                padding: '.15rem .35rem',
                minWidth: '2.1rem',
                textAlign: 'center',
              }}
            >
              {score}
            </span>
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
          {!lead.deepScored && <QuickScoreReasons reasons={r} />}
        </div>

        {/*
          Apply is the one action this card exists to offer; everything else
          is here for the exceptions. Five identically-weighted buttons made
          Apply just one option among equals, so the rest are ghost buttons -
          still one click away, but visibly the supporting cast rather than
          five things all shouting at once.
        */}
        <div className="row" style={{ flexWrap: 'nowrap', flex: 'none' }}>
          <a href={`/jobs/${lead.id}`}>
            <button className="ghost" title="Everything about this job on one page">
              View job
            </button>
          </a>
          {lead.status === 'NEW' ? (
            <>
              <button className="primary" disabled={busy} onClick={onApply}>
                Apply
              </button>
              <button className="ghost" disabled={busy} onClick={onShortlist}>
                Save
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={onApplied}
                title="You applied to this one yourself — record it and take it out of the queue"
              >
                Applied
              </button>
              <button className="danger ghost" disabled={busy} onClick={onReject}>
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
 * What a keyword score is actually made of.
 *
 * A number with nothing behind it is the reason the ranking felt arbitrary.
 * These two lines say it plainly: here is what the posting talks about that
 * you have done, and here is what it talks about that you have not.
 */
function QuickScoreReasons({
  reasons,
}: {
  reasons: {
    affinity?: number;
    sharedTerms?: string[];
    missingTerms?: string[];
    likedTerms?: string[];
    dislikedTerms?: string[];
  };
}) {
  const shared = reasons.sharedTerms ?? [];
  const missing = reasons.missingTerms ?? [];
  const learned = [...(reasons.likedTerms ?? []), ...(reasons.dislikedTerms ?? [])];
  if (!shared.length && !missing.length && !learned.length) return null;

  return (
    <div className="muted small" style={{ marginTop: '.3rem' }}>
      {shared.length > 0 && (
        <>
          <span style={{ color: 'var(--good)' }}>in your resume:</span> {shared.slice(0, 6).join(', ')}
        </>
      )}
      {shared.length > 0 && missing.length > 0 && ' · '}
      {missing.length > 0 && <>not in it: {missing.slice(0, 5).join(', ')}</>}
      {learned.length > 0 && ` · from your past picks: ${learned.slice(0, 4).join(', ')}`}
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
  // Two different things get counted here and the old labels ran them
  // together: "strong matches" is the score's opinion, computed the moment a
  // lead is crawled; "saved" is yours, and starts at zero until you act on
  // one. Seeing "8 strong matches" next to "0 worth applying" read as a
  // contradiction - it is really "8 the ranking likes, 0 you have saved yet".
  const cells: [number, string, string | undefined, string][] = [
    [counts.NEW ?? 0, 'new jobs found', undefined, 'Postings discovered that you have not yet decided on.'],
    [
      strong,
      'strong matches',
      strong > 0 ? 'var(--good)' : undefined,
      'Scored 70 or higher by the ranking - automatic, before you have looked at any of them.',
    ],
    [
      counts.SHORTLISTED ?? 0,
      'saved',
      undefined,
      'Leads you pressed "Save" on. Independent of score - nothing is saved until you save it.',
    ],
    [counts.APPLIED ?? 0, 'applied', undefined, 'Applications sent, by the automation or marked by hand.'],
    [counts.REJECTED ?? 0, 'rejected', undefined, 'Leads you turned down.'],
  ];
  return (
    <div className="row" style={{ gap: '2rem', marginTop: '1rem', flexWrap: 'wrap' }}>
      {cells.map(([value, label, tone, hint]) => (
        <div key={label} title={hint}>
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
          {report.rerankedExisting > 0 &&
            ` · ${report.rerankedExisting} lead${
              report.rerankedExisting === 1 ? '' : 's'
            } already in the queue re-ranked`}
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
