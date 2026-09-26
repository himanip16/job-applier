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

  return (
    <div className="notice" style={{ marginTop: '.9rem' }}>
      <strong>
        {dryRun
          ? `Would search ${report.boards.length} top-paying compan${report.boards.length === 1 ? 'y' : 'ies'} for ${report.queries.length} role${report.queries.length === 1 ? '' : 's'}.`
          : nothing
            ? 'No new jobs this time.'
            : `${report.newLeads} new job${report.newLeads === 1 ? '' : 's'} from ${boards.length} compan${
                boards.length === 1 ? 'y' : 'ies'
              }.`}
      </strong>{' '}
      {!dryRun && (
        <span className="muted small">
          Read {report.boards.filter((b) => !b.error).length} of {report.boards.length} top-paying companies ·{' '}
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
