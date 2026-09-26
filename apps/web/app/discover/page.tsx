'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, needsProfile } from '../../lib/api';
import { Icon, type IconName } from '../../components/Icon';
import { COUNTRIES, countryByCode, countryFromText } from '@ja/shared/countries';

interface Lead {
  id: string;
  url: string;
  ats: string;
  title: string;
  companyName: string;
  location: string | null;
  postedAt?: string | null;
  discoveredAt?: string | null;
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
  leads: Lead[];
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

const TAB_ICON: Record<string, IconName> = {
  NEW: 'sparkles',
  SHORTLISTED: 'bookmark',
  APPLIED: 'send',
  REJECTED: 'archive',
  ALL: 'list',
};

export default function DiscoverPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [companies, setCompanies] = useState<Company[]>([]);
  const [sources, setSources] = useState<{ id: string; handleHint: string }[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [searchConfigured, setSearchConfigured] = useState(true);
  const [report, setReport] = useState<SearchReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // No profile yet is a first visit, not a failure: it gets a welcome.
  const [noProfile, setNoProfile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rejecting, setRejecting] = useState<Lead | null>(null);
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
  // On by default, as it always was; off applies with your resume as it is,
  // which also starts the run straight away instead of after a model call.
  const [tailorResume, setTailorResume] = useState(true);
  useEffect(() => {
    try {
      setWriteCoverLetter(window.localStorage.getItem('ja.coverLetter') === 'on');
      setTailorResume(window.localStorage.getItem('ja.tailorResume') !== 'off');
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
    setLoading(true);
    try {
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
    } finally {
      setLoading(false);
    }
  }, [view, page]);

  /** Any change to what is being shown starts again at page one. */
  function change(patch: Partial<View>) {
    if (patch.q !== undefined) setTyped(patch.q);
    setView((v) => ({ ...v, ...patch }));
    setPage(1);
  }

  useEffect(() => {
    load().catch((e) => (needsProfile(e) ? setNoProfile(true) : setError(e.message)));
    api('/api/sources')
      .then((d) => {
        const dd = d as { sources: { id: string; handleHint: string }[]; rejectCategories: string[]; searchConfigured: boolean };
        setSources(dd.sources);
        setCategories(dd.rejectCategories);
        setSearchConfigured(dd.searchConfigured);
      })
      .catch(() => {});
  }, [load]);

  // Asked before every search: which country to look in.
  const [askCountry, setAskCountry] = useState<null | 'find' | 'preview'>(null);
  const [searchCountry, setSearchCountry] = useState('');
  useEffect(() => {
    let saved = '';
    try { saved = window.localStorage.getItem('ja.searchCountry') ?? ''; } catch { /* default below */ }
    if (countryByCode(saved)) { setSearchCountry(saved); return; }
    // First time: start from the profile's own country.
    api<{ profile: { country: string | null } | null }>('/api/profile')
      .then((d) => setSearchCountry(countryFromText(d.profile?.country)?.code ?? 'IN'))
      .catch(() => setSearchCountry('IN'));
  }, []);

  async function find(dryRun = false, country = searchCountry) {
    setAskCountry(null);
    try { window.localStorage.setItem('ja.searchCountry', country); } catch { /* not remembered, still used */ }
    setBusy(dryRun ? 'preview' : 'find');
    setError(null);
    setFlash(null);
    setReport(null);
    try {
      const rRaw = await api('/api/discovery/find', {
        method: 'POST',
        body: JSON.stringify({ deepScoreTop: 15, dryRun, country: country || undefined }),
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
      const crawlRaw = await api('/api/discovery/crawl', { method: 'POST', body: JSON.stringify({ deepScoreTop: 15 }) });
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

  async function decide(lead: Lead, action: 'apply' | 'shortlist' | 'applied') {
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
          body: JSON.stringify({ writeCoverLetter, autoTailorResume: tailorResume }),
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

  const failing = companies.filter((c) => c.lastCrawlNote?.startsWith('failed')).length;
  const pageIds = leads.map((l) => l.id);
  const allPicked = pageIds.length > 0 && pageIds.every((id) => picked.includes(id));

  const cardProps = (lead: Lead) => ({
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

  if (noProfile) {
    return (
      <div className="discover-page">
        <div className="discover-heading">
          <span className="section-title">Your next opportunity</span>
          <h1>Find work</h1>
        </div>
        <section className="discover-welcome">
          <span className="discover-welcome-icon" aria-hidden="true">
            <Icon name="sparkles" size={26} />
          </span>
          <h2>Set up your profile to see jobs picked for you</h2>
          <p>
            Upload your resume and the app reads your experience, then finds openings that match
            it and explains why each one fits. It takes about a minute.
          </p>
          <ol className="discover-welcome-steps">
            <li><Icon name="text" size={16} /> Upload your resume</li>
            <li><Icon name="checkCircle" size={16} /> Check the details it read</li>
            <li><Icon name="target" size={16} /> Come back here for your matches</li>
          </ol>
          <a href="/profile" className="btn primary discover-welcome-cta">
            Set up my profile <Icon name="arrowRight" size={16} />
          </a>
        </section>
      </div>
    );
  }

  return (
    <div className="discover-page">
      <div className="discover-heading">
        <div className="spread">
          <div style={{ minWidth: 0 }}>
            <span className="section-title">Your next opportunity</span>
            <h1>Find work</h1>
            <p className="sub" style={{ margin: 0, maxWidth: '46rem' }}>
              Discover roles that fit you. Review the match, save your favorites, and apply.
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
              onClick={() => setAskCountry('find')}
              title="Search the web for openings that match your profile"
            >
              <Icon name="sparkles" className={busy === 'find' ? 'spin' : undefined} />
              {busy === 'find' ? 'Searching…' : 'Find new jobs'}
            </button>
            <details className="discover-options">
              <summary>Search options <Icon name="chevron" size={14} className="chev" /></summary>
              <div className="discover-menu">
            <button
              disabled={busy !== null}
              onClick={() => setAskCountry('preview')}
              title="Show the searches it would run. Costs nothing and needs no key."
            >
              <Icon name="eye" /> {busy === 'preview' ? 'Working…' : 'Preview search'}
            </button>
            <button
              disabled={busy !== null}
              onClick={crawl}
              title="Re-read the boards already on the list, without searching"
            >
              <Icon name="refresh" className={busy === 'crawl' ? 'spin' : undefined} /> {busy === 'crawl' ? 'Re-checking…' : 'Re-check known boards'}
            </button>
              </div>
            </details>
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

        {flash && <div className="notice good" style={{ marginTop: '.9rem' }}>{flash}</div>}
        {error && <div className="notice bad" style={{ marginTop: '.9rem' }}>{error}</div>}
        {report && <SearchReportPanel report={report} />}
      </div>

      <div className="panel discover-results">
        <div className="panel-head">
          <h2>Your opportunities</h2>
          <div className="tabs" aria-label="Job status">
            {['NEW', 'SHORTLISTED', 'APPLIED', 'REJECTED', 'ALL'].map((s) => (
              <button
                key={s}
                aria-pressed={view.status === s}
                onClick={() => change({ status: s })}
              >
                <Icon name={TAB_ICON[s]!} size={15} />
                {{ NEW: 'For you', SHORTLISTED: 'Saved', APPLIED: 'Applied', REJECTED: 'Dismissed', ALL: 'All jobs' }[s]}
                {counts[s] !== undefined && <span className="muted nums"> {counts[s]}</span>}
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

        <div className="discover-preferences" role="group" aria-label="When I press Apply">
          <span className="discover-pref-title">When I press Apply</span>
          <label className="discover-pref">
            <input
              type="checkbox"
              checked={tailorResume}
              onChange={(e) => {
                setTailorResume(e.target.checked);
                try {
                  window.localStorage.setItem('ja.tailorResume', e.target.checked ? 'on' : 'off');
                } catch {
                  // Not being able to remember it is not a reason to refuse the change.
                }
              }}
            />
            <span>
              <strong>Tailor my resume to the job</strong>
              <span className="muted"> — adds the job's keywords your experience supports. One AI call; off applies with your resume as it is.</span>
            </span>
          </label>
          <label className="discover-pref">
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
            <span>
              <strong>Write a cover letter</strong>
              <span className="muted"> — a form that requires one gets one either way.</span>
            </span>
          </label>
        </div>

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
        />

        {loading ? <div className="discover-empty" role="status"><span className="spinner" /> Loading opportunities…</div> : leads.length === 0 ? (
          <div className="discover-empty" role="status">
            <span className="discover-empty-icon" aria-hidden="true">⌕</span>
            <h2>{error ? 'Jobs couldn’t load' : 'Make room for your next move'}</h2>
          <p className="muted small">
            {error ? 'Your job list is unavailable. Try again in a moment.' :
            pageInfo.total === 0
              ? view.q || view.minScore || view.remote !== 'any' || view.depth !== 'any'
                ? 'Nothing matches those filters. Widen them, or clear them.'
                : view.status === 'SHORTLISTED' ? 'Save a job to keep it here for later.' : 'No jobs here yet. Find new jobs to get started.'
              : 'No jobs in this view.'}
          </p>
          {error ? <button onClick={() => { setError(null); load().catch((e) => setError(e.message)); }}>Try again</button> :
            <button onClick={() => change({ ...DEFAULT_VIEW })}>Reset filters</button>}
          </div>
        ) : (
          <div className="discover-job-list">{leads.map((lead, i) => <LeadCard key={lead.id} index={i} {...cardProps(lead)} />)}</div>
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

      <details className="panel disclosure">
        <summary>
          <strong>Sources</strong>
          <span className="muted small">
            {companies.length} board{companies.length === 1 ? '' : 's'} watched
            {failing > 0 && `, ${failing} failing`}
          </span>
        </summary>
        <div className="disclosure-body">
          <CompanyManager companies={companies} sources={sources} onChange={load} />
        </div>
      </details>

      {askCountry && (
        <CountryDialog
          value={searchCountry}
          preview={askCountry === 'preview'}
          onChange={setSearchCountry}
          onCancel={() => setAskCountry(null)}
          onSearch={() => find(askCountry === 'preview', searchCountry)}
        />
      )}
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
const SORTS: { value: string; label: string }[] = [
  { value: 'score:desc', label: 'Best match' },
  { value: 'discovered:desc', label: 'Newest found' },
  { value: 'discovered:asc', label: 'Oldest found' },
  { value: 'company:asc', label: 'Company A–Z' },
  { value: 'title:asc', label: 'Title A–Z' },
];

const MATCH_STEPS = ['', '50', '70', '85'];

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
    view.q !== '' || view.minScore !== '' || view.remote !== 'any' || view.depth !== 'any';
  const sortValue = `${view.sort}:${view.dir}`;

  return (
    <div className="discover-controls">
      <div className="toolbar discover-toolbar">
        <div className="field grow">
          <span className="cap">search</span>
          <input
            type="search"
            aria-label="Search jobs"
            value={typed}
            placeholder="Search title, company or city"
            onChange={(e) => onTyped(e.target.value)}
          />
        </div>

        <label className="discover-select">
          <Icon name="sort" size={15} />
          <span className="sr-only">Sort jobs</span>
          <select
            value={SORTS.some((s) => s.value === sortValue) ? sortValue : 'score:desc'}
            onChange={(e) => {
              const [sort, dir] = e.target.value.split(':') as [View['sort'], View['dir']];
              onChange({ sort, dir });
            }}
          >
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>

        <label className="discover-select">
          <Icon name="pin" size={15} />
          <span className="sr-only">Work location</span>
          <select value={view.remote} onChange={(e) => onChange({ remote: e.target.value as View['remote'] })}>
            <option value="any">Anywhere</option>
            <option value="yes">Remote only</option>
            <option value="no">On-site</option>
          </select>
        </label>

        <details className="discover-filters">
          <summary><Icon name="sliders" size={15} /> More{view.depth !== 'any' ? ' •' : ''}</summary>
          <div className="discover-filter-fields">
            <div className="field">
              <span className="cap">How it was scored</span>
              <select
                aria-label="Match assessment"
                value={view.depth}
                onChange={(e) => onChange({ depth: e.target.value as View['depth'] })}
              >
                <option value="any">Any way</option>
                <option value="deep">Read in full by AI</option>
                <option value="quick">Keywords only</option>
              </select>
            </div>
            <div className="field">
              <span className="cap">Jobs per page</span>
              <select aria-label="Jobs per page" value={view.limit} onChange={(e) => onChange({ limit: Number(e.target.value) })}>
                {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
        </details>
      </div>

      <div className="discover-subbar">
        <div className="discover-chips" role="group" aria-label="Minimum match">
          {MATCH_STEPS.map((m) => (
            <button
              key={m || 'any'}
              aria-pressed={view.minScore === m}
              onClick={() => onChange({ minScore: m })}
            >
              {m ? `${m}%+ match` : 'Any match'}
            </button>
          ))}
        </div>
        <span className="discover-count">
          <strong>{total.toLocaleString()}</strong> job{total === 1 ? '' : 's'}
          {filtered && (
            <button
              className="discover-clear"
              onClick={() => onChange({ q: '', minScore: '', remote: 'any', depth: 'any' })}
              title="Clear the filters, keep the sort"
            >
              <Icon name="x" size={13} /> Clear filters
            </button>
          )}
        </span>
      </div>
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
}: {
  picked: string[];
  max: number;
  allPicked: boolean;
  pageCount: number;
  busy: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  onRescore: () => void;
}) {
  const over = picked.length > max;
  if (pageCount === 0 && picked.length === 0) return null;
  return (
    <div
      className="row discover-selection"
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

      {picked.length > 0 && <button
        className="primary"
        disabled={picked.length === 0 || busy}
        onClick={onRescore}
        title="Send the ticked postings to the model to be read properly"
      >
        {busy
          ? 'Reading…'
          : `Rescore selected${picked.length ? ` (${Math.min(picked.length, max)})` : ''}`}
      </button>}

      {picked.length > 0 && (
        <button onClick={onClear} disabled={busy}>
          clear selection
        </button>
      )}

      <span className="muted small">
        {picked.length === 0
          ? 'Select jobs for a deeper match assessment.'
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
  if (total === 0 || pages <= 1) return null;
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
  index,
  busy,
  error,
  picked,
  onPick,
  onApply,
  onShortlist,
  onApplied,
  onReject,
}: {
  lead: Lead;
  index: number;
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
  const tone = score >= 70 ? 'good' : score >= 45 ? 'warn' : 'bad';
  const actionable = lead.status === 'NEW' || lead.status === 'SHORTLISTED';

  return (
    <article
      className={`jc${picked ? ' is-selected' : ''}`}
      style={{ '--i': Math.min(index, 12) } as React.CSSProperties}
    >
      <header className="jc-head">
        <input
          type="checkbox"
          className="jc-pick"
          checked={picked}
          onChange={onPick}
          title="Pick this one to be read in full"
          aria-label={`Select ${lead.title} at ${lead.companyName}`}
        />
        <div className="jc-titles">
          <a href={`/jobs/${lead.id}`} className="jc-title">
            {lead.title}
          </a>
          <div className="jc-meta">
            <span className="jc-company"><Icon name="building" size={14} />{lead.companyName}</span>
            {lead.location && <span><Icon name="pin" size={14} />{lead.location}</span>}
            {lead.remote && <span className="jc-chip"><Icon name="globe" size={12} />Remote</span>}
            <a
              href={lead.url}
              target="_blank"
              rel="noreferrer"
              className="jc-posting"
              title="Open the original posting"
            >
              Posting <Icon name="external" size={12} />
            </a>
          </div>
        </div>
        <div className={`jc-score jc-score-${tone}`} title={lead.deepScored ? 'Read in full' : 'Ranked on keywords only, not read in full'}>
          <Icon name="target" size={14} />
          <strong>{score}%</strong>
          <span>{lead.deepScored ? 'match' : 'quick match'}</span>
        </div>
      </header>

      <JobDates postedAt={lead.postedAt} discoveredAt={lead.discoveredAt} />

      {r.dealbreaker && <div className="notice bad jc-note"><Icon name="alert" size={14} /> Blocker: {r.dealbreaker}</div>}
      {r.forIt?.length || r.againstIt?.length ? (
        <ul className="jc-verdict" aria-label="Why it matches">
          {r.forIt?.slice(0, 2).map((t, i) => (
            <li key={`+${i}`} className="jc-verdict-for"><Icon name="checkCircle" size={15} />{t}</li>
          ))}
          {r.againstIt?.slice(0, 2).map((t, i) => (
            <li key={`-${i}`} className="jc-verdict-against"><Icon name="alert" size={15} />{t}</li>
          ))}
        </ul>
      ) : null}
      {!lead.deepScored && <QuickScoreReasons reasons={r} />}

      {error && <div className="notice bad jc-note">{error}</div>}

      {open && (
        <pre className="jc-description">{lead.descriptionText ?? 'No description captured.'}</pre>
      )}

      {/*
        Apply is the one action this card exists to offer; everything else
        is here for the exceptions, so it reads as quiet text on the left
        rather than four more buttons competing with it.
      */}
      <footer className="jc-foot">
        <div className="jc-quiet">
          {actionable && lead.status === 'NEW' && (
            <button disabled={busy} onClick={onShortlist}><Icon name="bookmark" size={14} />Save</button>
          )}
          {actionable && (
            <button
              disabled={busy}
              onClick={onApplied}
              title="You applied to this one yourself — record it and take it out of the queue"
            >
              <Icon name="checkCircle" size={14} />Already applied
            </button>
          )}
          {actionable && (
            <button className="jc-reject" disabled={busy} onClick={onReject}>
              <Icon name="x" size={14} />Not for me
            </button>
          )}
          <button aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name="text" size={14} />{open ? 'Hide description' : 'Description'}
            <Icon name="chevron" size={13} className={open ? 'chev open' : 'chev'} />
          </button>
        </div>
        <div className="jc-main">
          <a href={`/jobs/${lead.id}`} className="btn jc-btn" title="Everything about this job on one page">
            <Icon name="eye" size={15} />View details
          </a>
          {actionable ? (
            <button className="primary jc-btn jc-apply" disabled={busy} onClick={onApply}>
              <Icon name="send" size={15} />Apply
              <Icon name="arrowRight" size={15} className="jc-arrow" />
            </button>
          ) : (
            <span className={`pill ${lead.status}`}>{lead.status}</span>
          )}
        </div>
      </footer>
    </article>
  );
}

/**
 * When the job was posted (if the board says) and when it was found here.
 * A posting's age is the best cheap signal of whether it is still open.
 */
function JobDates({ postedAt, discoveredAt }: { postedAt?: string | null; discoveredAt?: string | null }) {
  if (!postedAt && !discoveredAt) return null;
  const posted = postedAt ? new Date(postedAt) : null;
  const found = discoveredAt ? new Date(discoveredAt) : null;
  const stale = posted ? Date.now() - posted.getTime() > 30 * 86_400_000 : false;
  return (
    <div className={`jc-dates${stale ? ' is-stale' : ''}`}>
      {posted && (
        <span title={`Posted ${posted.toLocaleString()}`}>
          <Icon name="calendar" size={13} /> Posted {ago(posted)}
          {stale && <em> · older posting</em>}
        </span>
      )}
      {found && (
        <span title={`Found by Job Applier ${found.toLocaleString()}`}>
          <Icon name="clock" size={13} /> Found {shortDate(found)}
        </span>
      )}
    </div>
  );
}

function ago(d: Date): string {
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

function shortDate(d: Date): string {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/**
 * What a keyword score is actually made of, as chips.
 *
 * A number with nothing behind it is the reason the ranking felt arbitrary.
 * Fragments like "end" or "you'll" come out of the keyword split and mean
 * nothing to a reader, so they are left off the card.
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
  const readable = (t: string) => t.length > 3 && !/['’]/.test(t);
  const shared = [...new Set(reasons.sharedTerms ?? [])].filter(readable).slice(0, 5);
  const missing = [...new Set(reasons.missingTerms ?? [])].filter((t) => readable(t) && !shared.includes(t)).slice(0, 3);
  if (!shared.length && !missing.length) return null;

  return (
    <ul className="jc-reasons" aria-label="Why it ranked here">
      {shared.map((t) => (
        <li key={`s-${t}`} className="jc-for" title="In your resume">{t}</li>
      ))}
      {missing.map((t) => (
        <li key={`m-${t}`} className="jc-missing" title="Not in your resume">{t}</li>
      ))}
    </ul>
  );
}

/** Where to look. Asked before every search, remembered as the next default. */
function CountryDialog({
  value,
  preview,
  onChange,
  onCancel,
  onSearch,
}: {
  value: string;
  preview: boolean;
  onChange: (code: string) => void;
  onCancel: () => void;
  onSearch: () => void;
}) {
  const name = countryByCode(value)?.name ?? 'this country';
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal discover-country"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onSearch(); }}
      >
        <span className="discover-welcome-icon" aria-hidden="true"><Icon name="globe" size={22} /></span>
        <h2>Where should I look?</h2>
        <p className="sub">
          {preview
            ? 'See the searches it would run for this country. Costs nothing.'
            : 'Jobs are searched in this country only. Remote roles open to it are included.'}
        </p>
        <label className="field">
          <span className="cap">Country</span>
          <select value={value} onChange={(e) => onChange(e.target.value)} autoFocus>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: '.5rem', marginTop: '1rem' }}>
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
            <Icon name={preview ? 'eye' : 'sparkles'} size={15} />
            {preview ? `Preview for ${name}` : `Search in ${name}`}
          </button>
        </div>
      </form>
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

      <details className="disclosure inline" open={dryRun} style={{ marginTop: '.6rem' }}>
        <summary className="small">
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
        <details className="disclosure inline" style={{ marginTop: '.35rem' }}>
          <summary className="small">
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
