'use client';

import type { SearchReport } from '../types';

/**
 * What the run actually did.
 *
 * A single "found 12 jobs" line hides the two things worth knowing: what it
 * searched for on your behalf, and which companies it turned up. Both are
 * shown, because the searches are the part you will want to correct — and the
 * way to correct them is to reject a few leads, which the queue below makes
 * one click.
 */
export function SearchReportPanel({ report }: { report: SearchReport }) {
  const boards = report.boards.filter((b) => b.kept > 0);
  const nothing = report.newLeads === 0;
  const dryRun = report.notes.some((n) => n.startsWith('Dry run:'));
  // Older servers did not send these; treat them as nothing dropped.
  const offPlan = report.skippedOffPlan ?? 0;
  const wrongDomain = report.skippedWrongDomain ?? 0;
  const fetched = report.jobsFetched ?? report.boards.reduce((sum, b) => sum + b.openings, 0);
  const failed = report.boards.filter((b) => b.error).length;
  const partial = report.boards.filter((b) => !b.error && b.warnings?.length).length;
  const noSource = report.noSource ?? [];
  const recentlyCrawled = report.recentlyCrawled ?? [];
  const unknownLocation = report.keptUnknownLocation ?? 0;
  const search = report.openSearch;
  const fromSearch = report.boards.filter((b) => b.via === 'search').length;
  const dropped = [
    { label: 'not in plan', count: offPlan, examples: report.droppedExamples?.offPlan ?? [] },
    { label: 'not engineering', count: wrongDomain, examples: report.droppedExamples?.wrongDomain ?? [] },
    { label: 'above the experience or seniority limit', count: report.skippedTooSenior ?? 0, examples: report.droppedExamples?.tooSenior ?? [] },
    { label: 'internship or new-grad', count: report.skippedTooJunior ?? 0, examples: report.droppedExamples?.tooJunior ?? [] },
    { label: 'outside the chosen country', count: report.skippedOtherCountry ?? 0, examples: report.droppedExamples?.otherCountry ?? [] },
    { label: 'older than 90 days', count: report.skippedTooOld ?? 0, examples: report.droppedExamples?.tooOld ?? [] },
  ].filter((d) => d.count > 0);

  return (
    <div className="notice" style={{ marginTop: '.9rem' }}>
      <strong>
        {dryRun
          ? `Would read ${report.boards.length} listed compan${report.boards.length === 1 ? 'y' : 'ies'} for ${report.queries.length} role${report.queries.length === 1 ? '' : 's'}.`
          : nothing
            ? 'No new jobs this time.'
            : `${report.newLeads} new job${report.newLeads === 1 ? '' : 's'} from ${boards.length} compan${
                boards.length === 1 ? 'y' : 'ies'
              }.`}
      </strong>{' '}
      {!dryRun && (
        <span className="muted small">
          {report.boards.length} companies checked
          {fromSearch > 0 && ` (${fromSearch} found by open search)`} · {failed} failed · {partial} with limited coverage ·{' '}
          {fetched} postings fetched · {report.jobsSeen} passed filters ·{' '}
          {report.skippedAlreadySeen} already seen · {report.deepScored} assessed by the model
          {noSource.length > 0 && ` · ${noSource.length} with no careers source set up`}
          {recentlyCrawled.length > 0 && ` · ${recentlyCrawled.length} skipped, read in the last 4 hours`}
          {unknownLocation > 0 && ` · ${unknownLocation} kept with location unknown`}
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
          {dryRun ? 'The roles it would search for' : 'Roles it searched for'}
          {report.planSource === 'profile' && ' (derived from your profile, no model used)'}
        </summary>
        <ul className="small muted" style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
          {report.queries.map((q) => (
            <li key={q.query}>
              &ldquo;{q.query}&rdquo;
              {!dryRun && ` — ${q.hits} matching opening${q.hits === 1 ? '' : 's'}`}
            </li>
          ))}
        </ul>
        {report.roleTitles.length > 0 && (
          <p className="small muted" style={{ margin: '.5rem 0 0' }}>
            Reject a few leads below and the next search narrows.
            {dryRun && ` Companies: ${report.boards.map((b) => b.company).join(', ')}.`}
          </p>
        )}
      </details>

      {!dryRun && search?.ran && (
        <details className="disclosure inline" style={{ marginTop: '.35rem' }}>
          <summary className="small">
            Open search: {search.companiesFound} compan{search.companiesFound === 1 ? 'y' : 'ies'} beyond the list
          </summary>
          <ul className="small muted" style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
            {search.queries.map((q) => (
              <li key={q.query}>
                &ldquo;{q.query}&rdquo; — {q.hits} result{q.hits === 1 ? '' : 's'} on a job board
              </li>
            ))}
          </ul>
        </details>
      )}

      {!dryRun && report.boards.length > 0 && (
        <details className="disclosure inline" style={{ marginTop: '.35rem' }}>
          <summary className="small">
            Source coverage
          </summary>
          <ul className="small muted" style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
            {report.boards.map((b) => (
              <li key={`${b.ats}:${b.slug}`}>
                {b.company} <span className="src">{b.ats}</span>
                {b.via === 'search' && <span className="src">open search</span>} — {b.error
                  ? `failed: ${b.error}`
                  : `${b.openings} postings fetched, ${b.kept} new jobs saved`}
                {b.warnings?.map((warning) => <p key={warning} style={{ margin: '.2rem 0' }}>{warning}</p>)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* A filter that is too strict hides jobs silently; the titles it dropped are how you notice. */}
      {!dryRun && dropped.length > 0 && (
        <details className="disclosure inline" style={{ marginTop: '.35rem' }}>
          <summary className="small">What the filters dropped</summary>
          <ul className="small muted" style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
            {dropped.map((d) => (
              <li key={d.label}>
                {d.count} {d.label}
                {d.examples.length > 0 && `, e.g. ${d.examples.map((t) => `“${t}”`).join(', ')}`}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Not an error: these companies are listed but nobody has pointed them at a careers API or page yet. */}
      {noSource.length > 0 && (
        <details className="disclosure inline" style={{ marginTop: '.35rem' }}>
          <summary className="small">
            {noSource.length} compan{noSource.length === 1 ? 'y' : 'ies'} with no careers source set up
          </summary>
          <p className="small muted" style={{ margin: '.4rem 0 0' }}>
            {noSource.join(', ')}.
          </p>
        </details>
      )}

      {/* Read in the last 4 hours; their postings are already in the queue from that read. */}
      {recentlyCrawled.length > 0 && (
        <details className="disclosure inline" style={{ marginTop: '.35rem' }}>
          <summary className="small">
            {recentlyCrawled.length} compan{recentlyCrawled.length === 1 ? 'y' : 'ies'} skipped, read in the last 4 hours
          </summary>
          <p className="small muted" style={{ margin: '.4rem 0 0' }}>
            {recentlyCrawled
              .map((r) => `${r.company} (${new Date(r.crawledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`)
              .join(', ')}
            .
          </p>
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
