'use client';

import { useCallback, useEffect, useState } from 'react';
import { countryByCode, countryFromText } from '@ja/shared/countries';
import { api, needsProfile } from '../../lib/api';
import { Icon, type IconName } from '../../components/Icon';
import { ApplyPreferences, useApplyPrefs } from './components/ApplyPreferences';
import { CountryDialog, WORLDWIDE, type CountryAction } from './components/CountryDialog';
import { FilterBar } from './components/FilterBar';
import { LeadCard } from './components/LeadCard';
import { Pager } from './components/Pager';
import { RejectDialog } from './components/RejectDialog';
import { SearchReportPanel } from './components/SearchReportPanel';
import { SelectionBar } from './components/SelectionBar';
import type { Lead, LeadPage, RescoreResult, SearchReport } from './types';
import { DEFAULT_VIEW, FILTER_KEYS, isDefault, pageFromQuery, queryString, viewFromQuery, type View } from './view';
import styles from './discover.module.css';

/** Where the last view is kept, for the nav link's bare /discover. */
const VIEW_KEY = 'discover.view';

const TABS: { status: string; label: string; icon: IconName }[] = [
  { status: 'NEW', label: 'For you', icon: 'sparkles' },
  { status: 'SHORTLISTED', label: 'Saved', icon: 'bookmark' },
  { status: 'PROCESSING', label: 'Processing', icon: 'clock' },
  { status: 'APPLIED', label: 'Applied', icon: 'send' },
  { status: 'REJECTED', label: 'Dismissed', icon: 'archive' },
  { status: 'ALL', label: 'All jobs', icon: 'list' },
];

/** The match score, in percent, that "Auto-apply" treats as good enough. */
const AUTO_APPLY_MIN_MATCH = 70;

const EMPTY_FACETS: LeadPage['facets'] = { companies: [], cities: [], tiers: [] };

interface SearchProgress {
  phase: 'reading' | 'scoring' | 'done';
  startedAt: string;
  companiesTotal: number;
  companiesDone: number;
  reading: string[];
  newLeads: number;
}

export default function DiscoverPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const [categories, setCategories] = useState<string[]>([]);
  const [report, setReport] = useState<SearchReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // No profile yet is a first visit, not a failure: it gets a welcome.
  const [noProfile, setNoProfile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rejecting, setRejecting] = useState<Lead | null>(null);
  // Keyed by lead. An error from a card has to appear on that card: the shared
  // banner at the top is often a screen away from the button that was pressed.
  const [leadErrors, setLeadErrors] = useState<Record<string, string>>({});
  const [prefs, setPrefs] = useApplyPrefs();

  // Which page of which slice of the queue is on screen. Kept in the address
  // bar too, so a reload or a shared link shows the same list.
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [page, setPage] = useState(1);
  const [ready, setReady] = useState(false);
  const [pageInfo, setPageInfo] = useState({ total: 0, pages: 1, maxRescoreBatch: 25 });

  // Typed straight into the box; `view.q` lags it by a beat so a search does
  // not fire a request per keystroke.
  const [typed, setTyped] = useState('');

  // Ticked leads, by id. Kept across pages on purpose: picking three here and
  // two on the next page, then rescoring all five, is the point.
  const [picked, setPicked] = useState<string[]>([]);
  const [applying, setApplying] = useState<string | null>(null);
  const [confirmAuto, setConfirmAuto] = useState<{ ids: string[]; which: string } | null>(null);

  // The address bar wins; a bare /discover (the nav link) falls back to the
  // last view, so opening a job or another page and coming back keeps the
  // filters and the page you were on.
  useEffect(() => {
    let search = window.location.search;
    if (!new URLSearchParams(search).has('status')) {
      try {
        search = localStorage.getItem(VIEW_KEY) ?? search;
      } catch {}
    }
    const fromUrl = viewFromQuery(search);
    setView((v) => ({ ...v, ...fromUrl }));
    setTyped(fromUrl.q ?? '');
    setPage(pageFromQuery(search));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const qs = queryString(view, page);
    window.history.replaceState(null, '', `${window.location.pathname}?${qs}`);
    try {
      localStorage.setItem(VIEW_KEY, `?${qs}`);
    } catch {}
  }, [view, page, ready]);

  useEffect(() => {
    if (typed === view.q) return;
    const t = setTimeout(() => change({ q: typed }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, view.q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const l = await api<LeadPage>(`/api/leads?${queryString(view, page)}`);
      setLeads(l.leads);
      setCounts(l.counts);
      setFacets(l.facets ?? EMPTY_FACETS);
      setPageInfo({ total: l.total, pages: l.pages, maxRescoreBatch: l.maxRescoreBatch });
      // The server clamps a page past the end; follow it.
      if (l.page !== page) setPage(l.page);
    } finally {
      setLoading(false);
    }
  }, [view, page]);

  /** The list re-read without the loading spinner, for jobs arriving while a search runs. */
  const refresh = useCallback(async () => {
    const l = await api<LeadPage>(`/api/leads?${queryString(view, page)}`);
    setLeads(l.leads);
    setCounts(l.counts);
    setFacets(l.facets ?? EMPTY_FACETS);
    setPageInfo({ total: l.total, pages: l.pages, maxRescoreBatch: l.maxRescoreBatch });
  }, [view, page]);

  // A search saves each company's jobs as soon as that company answers. While
  // one runs, ask how far it has got and pull in new jobs as they land, rather
  // than showing nothing until every company has been read.
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  useEffect(() => {
    if (busy !== 'find') {
      setProgress(null);
      return;
    }
    // The server keeps the last finished search too; only this one counts.
    const since = Date.now() - 5000;
    let shown = 0;
    let stopped = false;
    const tick = async () => {
      try {
        const { progress: p } = await api<{ progress: SearchProgress | null }>('/api/discovery/progress');
        if (stopped || !p || new Date(p.startedAt).getTime() < since) return;
        setProgress(p);
        if (p.newLeads > shown) {
          shown = p.newLeads;
          await refresh();
        }
      } catch {
        // A missed tick is caught up by the next one, and the search's own result follows.
      }
    };
    void tick();
    const timer = setInterval(tick, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [busy, refresh]);

  /** Any change to what is being shown starts again at page one. */
  function change(patch: Partial<View>) {
    if (patch.q !== undefined) setTyped(patch.q);
    setView((v) => ({ ...v, ...patch }));
    setPage(1);
  }

  useEffect(() => {
    if (!ready) return;
    load().catch((e) => (needsProfile(e) ? setNoProfile(true) : setError(e.message)));
  }, [load, ready]);

  useEffect(() => {
    api<{ rejectCategories: string[] }>('/api/sources')
      .then((d) => setCategories(d.rejectCategories))
      .catch(() => {});
  }, []);

  // ---- country-scoped actions ------------------------------------------------
  //
  // Everything that reads or prunes jobs works in one country (or worldwide),
  // asked for each time and remembered.
  const [asking, setAsking] = useState<CountryAction | null>(null);
  const [country, setCountry] = useState('');
  useEffect(() => {
    let saved = '';
    try { saved = window.localStorage.getItem('ja.searchCountry') ?? ''; } catch { /* default below */ }
    if (saved === WORLDWIDE || countryByCode(saved)) { setCountry(saved); return; }
    api<{ profile: { country: string | null } | null }>('/api/profile')
      .then((d) => setCountry(countryFromText(d.profile?.country)?.code ?? 'IN'))
      .catch(() => setCountry('IN'));
  }, []);

  async function run(action: CountryAction) {
    setAsking(null);
    try { window.localStorage.setItem('ja.searchCountry', country); } catch { /* still used */ }
    const worldwide = country === WORLDWIDE;
    const name = worldwide ? 'worldwide' : countryByCode(country)?.name ?? country;
    // No country: the server searches everywhere and keeps jobs open to India.
    const target = worldwide ? undefined : country;
    setBusy(action);
    setError(null);
    setFlash(null);
    if (action === 'find') setReport(null);
    try {
      if (action === 'find') {
        const r = await api<{ report: SearchReport }>('/api/discovery/find', {
          method: 'POST',
          body: JSON.stringify({ deepScoreTop: 15, country: target }),
        });
        setReport(r.report);
      } else if (action === 'crawl') {
        const { report: r } = await api<{ report: Record<string, number> & { errors: { company: string }[] } }>(
          '/api/discovery/crawl',
          { method: 'POST', body: JSON.stringify({ deepScoreTop: 15, country: target }) },
        );
        setFlash(
          `Searched ${r.companiesCrawled} watch-list companies${worldwide ? '' : ` for ${name}`}: ${r.newLeads} new job${r.newLeads === 1 ? '' : 's'}. ` +
            `Skipped ${r.skippedOtherCountry ?? 0} ${worldwide ? 'not open to India' : `outside ${name}`} and ` +
            `${r.skippedTooOld ?? 0} older than 3 months.` +
            (r.errors.length ? ` ${r.errors.length} board(s) failed.` : ''),
        );
      } else {
        const { report: r } = await api<{
          report: { checked: number; removed: number; removedBy: Record<string, number>; unreachable: string[]; unknown?: number; maxPerCompany?: number };
        }>('/api/discovery/recheck-leads', { method: 'POST', body: JSON.stringify({ country: target }) });
        const b = r.removedBy;
        const unknown = r.unknown ?? 0;
        setFlash(
          (r.removed === 0
            ? `Checked ${r.checked} jobs — none were closed, too old, off-target ${worldwide ? 'or not open to India' : `for ${name}`} or over the per-company limit.`
            : `Checked ${r.checked} jobs and removed ${r.removed}: ${b.wrongDomain} not engineering roles, ` +
                `${b.otherCountry} ${worldwide ? 'not open to India' : `outside ${name}`}, ` +
                `${b.closed} closed, ${b.tooOld} older than 3 months, ${b.tooSenior} too senior` +
                (b.tooJunior ? `, ${b.tooJunior} internship or new-grad` : '') +
                (b.overCap ? `, ${b.overCap} beyond the best ${r.maxPerCompany ?? 3} per company` : '') +
                '.') +
            (unknown ? ` ${unknown} posting page${unknown === 1 ? '' : 's'} gave no clear answer, so ${unknown === 1 ? 'it was' : 'they were'} kept.` : ''),
        );
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // ---- per-job actions ---------------------------------------------------------
  async function decide(lead: Lead, action: 'apply' | 'shortlist' | 'applied') {
    setBusy(lead.id);
    setLeadErrors(({ [lead.id]: _, ...rest }) => rest);
    // Open the tab now, inside the click, so the popup blocker allows it;
    // it is pointed at the application once the server has made one.
    const tab = action === 'apply' ? window.open('about:blank', '_blank') : null;
    try {
      if (action === 'apply') {
        const r = await api<{ applicationId: string }>(`/api/leads/${lead.id}/apply`, {
          method: 'POST',
          body: JSON.stringify({ writeCoverLetter: prefs.writeCoverLetter, autoTailorResume: prefs.tailorResume }),
        });
        const href = `/applications/${r.applicationId}`;
        if (tab) tab.location.href = href;
        else window.open(href, '_blank');
        await load();
        return;
      }
      await api(`/api/leads/${lead.id}/${action === 'applied' ? 'applied' : 'shortlist'}`, { method: 'POST' });
      if (action === 'applied') setFlash(`Marked "${lead.title}" as applied. It is in the tracker now, and out of the queue.`);
      await load();
    } catch (e) {
      tab?.close();
      setLeadErrors((prev) => ({ ...prev, [lead.id]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  /** Read the ticked postings properly - exactly those, not the whole queue. */
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
        `Read ${r.rescored} posting${r.rescored === 1 ? '' : 's'} in full and re-scored ${r.rescored === 1 ? 'it' : 'them'}.` +
          (failed.length ? ` ${failed.length} could not be read — see the rows below.` : ''),
      );
      // Keep the failures ticked so a retry is one press.
      setPicked(failed.map((x) => x.id));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Autopilot: apply to every ticked job and submit each without asking.
   *
   * The server queues them and runs one at a time, so this only has to hand
   * them over. A few at once, because each request can spend up to a minute
   * tailoring the resume before it returns.
   */
  async function autoApplyPicked() {
    await autoApply([...picked], (n) => `${n} ticked job${n === 1 ? '' : 's'}`);
  }

  /**
   * Autopilot over the whole list: every job you have not acted on (For you
   * and Saved) whose match is at least AUTO_APPLY_MIN_MATCH, across all pages.
   */
  async function autoApplyGoodMatches() {
    setBusy('collect');
    setError(null);
    let ids: string[] = [];
    try {
      for (const status of ['NEW', 'SHORTLISTED']) {
        for (let p = 1; ; p++) {
          const r = await api<{ leads: Lead[]; pages: number }>(
            `/api/leads?status=${status}&minScore=${AUTO_APPLY_MIN_MATCH}&sort=score&limit=100&page=${p}`,
          );
          ids.push(...r.leads.map((l) => l.id));
          if (p >= r.pages) break;
        }
      }
      ids = [...new Set(ids)];
    } catch (e) {
      setError((e as Error).message);
      return;
    } finally {
      setBusy(null);
    }
    if (!ids.length) {
      setFlash(`No jobs at ${AUTO_APPLY_MIN_MATCH}%+ match waiting to be applied to.`);
      return;
    }
    await autoApply(ids, (n) => `${n} job${n === 1 ? '' : 's'} at ${AUTO_APPLY_MIN_MATCH}%+ match`);
  }

  /**
   * Ask first, in the page. window.confirm is not used: embedded browsers and
   * "block dialogs from this page" make it return false without showing
   * anything, and the button then silently does nothing.
   */
  async function autoApply(ids: string[], describe: (n: number) => string) {
    if (ids.length) setConfirmAuto({ ids, which: describe(ids.length) });
  }

  async function runAutoApply(ids: string[]) {
    setConfirmAuto(null);
    setError(null);
    setFlash(null);
    setLeadErrors({});
    const failed: Record<string, string> = {};
    let done = 0;
    setApplying(`Queuing 0 of ${ids.length}…`);
    const next = [...ids];
    const worker = async () => {
      for (let id = next.shift(); id; id = next.shift()) {
        try {
          await api(`/api/leads/${id}/apply`, {
            method: 'POST',
            body: JSON.stringify({
              requiresReview: false,
              writeCoverLetter: prefs.writeCoverLetter,
              autoTailorResume: prefs.tailorResume,
            }),
          });
        } catch (e) {
          failed[id] = (e as Error).message;
        }
        done++;
        setApplying(`Queuing ${done} of ${ids.length}…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
    setApplying(null);
    const failedIds = Object.keys(failed);
    setLeadErrors(failed);
    setPicked(failedIds);
    const ok = ids.length - failedIds.length;
    setFlash(
      `Auto-applying to ${ok} job${ok === 1 ? '' : 's'}. They run one after another and submit by themselves; follow along on Runs.` +
        (failedIds.length ? ` ${failedIds.length} could not be started — see the rows below.` : ''),
    );
    await load();
  }

  const pageIds = leads.map((l) => l.id);
  const allPicked = pageIds.length > 0 && pageIds.every((id) => picked.includes(id));
  const filtered = FILTER_KEYS.some((k) => !isDefault(view, k));

  if (noProfile) return <Welcome />;

  return (
    <div className="discover-page">
      <div className="discover-heading">
        <div className="spread">
          <div style={{ minWidth: 0 }}>
            <span className="section-title">Your next opportunity</span>
            <h1>Find work</h1>
            <p className="sub" style={{ margin: 0, maxWidth: '46rem' }}>
              Roles at the best-paying companies, ranked by how well they fit you.
            </p>
          </div>
          <div className={styles.actions}>
            <button className="primary" disabled={busy !== null} onClick={() => setAsking('find')}>
              <Icon name="sparkles" className={busy === 'find' ? 'spin' : undefined} />
              {busy === 'find'
                ? progress?.phase === 'reading'
                  ? `Searching… ${progress.companiesDone}/${progress.companiesTotal}`
                  : progress?.phase === 'scoring'
                    ? 'Ranking…'
                    : 'Searching…'
                : 'Search top companies'}
            </button>
            <button
              disabled={busy !== null || applying !== null}
              onClick={autoApplyGoodMatches}
              title={`Apply to every job at ${AUTO_APPLY_MIN_MATCH}%+ match and submit each without asking. You confirm the count first.`}
            >
              <Icon name="send" className={busy === 'collect' ? 'spin' : undefined} />
              {applying ?? (busy === 'collect' ? 'Finding matches…' : `Apply to all ${AUTO_APPLY_MIN_MATCH}%+ matches`)}
            </button>
            <button disabled={busy !== null} onClick={() => setAsking('recheck')} title="Remove jobs in For you that are closed, too old, too senior, or in the wrong country, and keep only the best few per company. Never adds jobs.">
              <Icon name="checkCircle" className={busy === 'recheck' ? 'spin' : undefined} />
              {busy === 'recheck' ? 'Removing…' : 'Remove stale jobs'}
            </button>
            <details className={styles.menu}>
              <summary>More <Icon name="chevron" size={14} /></summary>
              <div className={styles.menuBody}>
                <button disabled={busy !== null} onClick={() => setAsking('crawl')}>
                  <Icon name="refresh" className={busy === 'crawl' ? 'spin' : undefined} />
                  <span>Search my watch list<span className={styles.menuHint}>Re-read every company on your watch list for new jobs</span></span>
                </button>
                <a href="/watchlist" className={styles.menuLink}>
                  <Icon name="list" />
                  <span>Edit watch list<span className={styles.menuHint}>See, add or remove the companies it checks</span></span>
                </a>
              </div>
            </details>
          </div>
        </div>

        {busy === 'find' && progress && (
          <div className="notice" role="status" aria-live="polite" style={{ marginTop: '.9rem' }}>
            {progress.phase === 'reading'
              ? `Read ${progress.companiesDone} of ${progress.companiesTotal} companies · ${progress.newLeads} new job${progress.newLeads === 1 ? '' : 's'} added so far` +
                (progress.reading.length ? ` · now reading ${progress.reading.slice(0, 3).join(', ')}` : '')
              : `All ${progress.companiesTotal} companies read · ${progress.newLeads} new job${progress.newLeads === 1 ? '' : 's'} added · ranking the best matches`}
          </div>
        )}
        {flash && <div className="notice good" style={{ marginTop: '.9rem' }}>{flash}</div>}
        {error && <div className="notice bad" style={{ marginTop: '.9rem' }}>{error}</div>}
        {report && <SearchReportPanel report={report} />}
      </div>

      <div className={styles.tabsRow}>
        <div className="tabs" aria-label="Job status">
          {TABS.map((t) => (
            <button key={t.status} aria-pressed={view.status === t.status} onClick={() => change({ status: t.status })}>
              <Icon name={t.icon} size={15} />
              {t.label}
              {counts[t.status] !== undefined && <span className="muted nums"> {counts[t.status]}</span>}
            </button>
          ))}
        </div>
        <ApplyPreferences prefs={prefs} onChange={setPrefs} />
      </div>


      <FilterBar view={view} typed={typed} facets={facets} total={pageInfo.total} onTyped={setTyped} onChange={change} />

      <div className="panel discover-results">
        <SelectionBar
          picked={picked}
          max={pageInfo.maxRescoreBatch}
          allPicked={allPicked}
          pageCount={pageIds.length}
          busy={busy === 'rescore'}
          onToggleAll={() =>
            setPicked((p) => (allPicked ? p.filter((id) => !pageIds.includes(id)) : [...new Set([...p, ...pageIds])]))
          }
          onClear={() => setPicked([])}
          onRescore={rescorePicked}
          applying={applying}
          onAutoApply={autoApplyPicked}
        />

        {loading ? (
          <div className="discover-empty" role="status"><span className="spinner" /> Loading opportunities…</div>
        ) : leads.length === 0 ? (
          <div className="discover-empty" role="status">
            <span className="discover-empty-icon" aria-hidden="true">⌕</span>
            <h2>{error ? 'Jobs couldn’t load' : filtered ? 'Nothing matches these filters' : 'Make room for your next move'}</h2>
            <p className="muted small">
              {error
                ? 'Your job list is unavailable. Try again in a moment.'
                : filtered
                  ? 'Remove a filter above to see more.'
                  : view.status === 'SHORTLISTED'
                    ? 'Save a job to keep it here for later.'
                    : view.status === 'PROCESSING'
                      ? 'Jobs you hit Apply on wait here until they are submitted.'
                    : 'No jobs here yet. Search top companies to get started.'}
            </p>
            {error ? (
              <button onClick={() => { setError(null); load().catch((e) => setError(e.message)); }}>Try again</button>
            ) : (
              filtered && <button onClick={() => change(Object.fromEntries(FILTER_KEYS.map((k) => [k, DEFAULT_VIEW[k]])))}>Clear all filters</button>
            )}
          </div>
        ) : (
          <div className="discover-job-list">
            {leads.map((lead, i) => (
              <LeadCard
                key={lead.id}
                index={i}
                lead={lead}
                busy={busy === lead.id || busy === 'rescore'}
                error={leadErrors[lead.id]}
                picked={picked.includes(lead.id)}
                onPick={() => setPicked((p) => (p.includes(lead.id) ? p.filter((x) => x !== lead.id) : [...p, lead.id]))}
                onApply={() => decide(lead, 'apply')}
                onShortlist={() => decide(lead, 'shortlist')}
                onApplied={() => decide(lead, 'applied')}
                onReject={() => setRejecting(lead)}
              />
            ))}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.5rem' }}>
          <Pager page={page} pages={pageInfo.pages} total={pageInfo.total} limit={view.limit} shown={leads.length} onPage={setPage} />
          <label className="row small muted" style={{ gap: '.4rem', marginTop: '.9rem' }}>
            Per page
            <select value={view.limit} onChange={(e) => change({ limit: Number(e.target.value) })}>
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      </div>

      {asking && (
        <CountryDialog value={country} action={asking} onChange={setCountry} onCancel={() => setAsking(null)} onConfirm={() => run(asking)} />
      )}
      {confirmAuto && (
        <div className="modal-backdrop" onClick={() => setConfirmAuto(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 .2rem' }}>
              Auto-apply to {confirmAuto.which}?
            </h2>
            <p className="sub">
              Each one is filled in and submitted without asking you first. Anything that needs you — a
              question it cannot answer from your profile, a captcha, a sign-in — is set aside and the rest
              carry on.
            </p>
            <div className="row">
              <button className="primary" onClick={() => void runAutoApply(confirmAuto.ids)}>
                Apply and submit
              </button>
              <button onClick={() => setConfirmAuto(null)}>Cancel</button>
            </div>
          </div>
        </div>
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

function Welcome() {
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
          Upload your resume and the app reads your experience, then finds openings that match it and explains why
          each one fits. It takes about a minute.
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
