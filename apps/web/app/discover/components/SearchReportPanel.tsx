'use client';

import { useState } from 'react';
import { Icon } from '../../../components/Icon';
import type { SearchReport } from '../types';
import styles from './report.module.css';

/** Company rows shown before "Show all". */
const FIRST_ROWS = 6;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the run actually did.
 *
 * A single "found 12 jobs" line hides the two things worth knowing: what it
 * searched for on your behalf, and which companies it turned up. Both are
 * shown, because the searches are the part you will want to correct — and the
 * way to correct them is to reject a few leads, which the queue below makes
 * one click. The rest of the detail is one click away, not on top.
 */
export function SearchReportPanel({ report, onClose }: { report: SearchReport; onClose?: () => void }) {
  const [allRows, setAllRows] = useState(false);
  const dryRun = report.notes.some((n) => n.startsWith('Dry run:'));
  // Older servers did not send these; treat them as nothing dropped.
  const fetched = report.jobsFetched ?? report.boards.reduce((sum, b) => sum + b.openings, 0);
  const noSource = report.noSource ?? [];
  const recentlyCrawled = report.recentlyCrawled ?? [];
  const unknownLocation = report.keptUnknownLocation ?? 0;
  const search = report.openSearch;
  const dropped = [
    { label: 'Not in your roles', count: report.skippedOffPlan ?? 0, examples: report.droppedExamples?.offPlan ?? [] },
    { label: 'Not engineering', count: report.skippedWrongDomain ?? 0, examples: report.droppedExamples?.wrongDomain ?? [] },
    { label: 'Too senior', count: report.skippedTooSenior ?? 0, examples: report.droppedExamples?.tooSenior ?? [] },
    { label: 'Internship or new-grad', count: report.skippedTooJunior ?? 0, examples: report.droppedExamples?.tooJunior ?? [] },
    { label: 'Outside the chosen country', count: report.skippedOtherCountry ?? 0, examples: report.droppedExamples?.otherCountry ?? [] },
    { label: 'Older than 90 days', count: report.skippedTooOld ?? 0, examples: report.droppedExamples?.tooOld ?? [] },
  ].filter((d) => d.count > 0);

  const single = report.boards.length === 1 ? report.boards[0]!.company : null;
  const withJobs = report.boards.filter((b) => b.kept > 0).length;
  const title = dryRun
    ? `Would read ${plural(report.boards.length, 'company', 'companies')} for ${plural(report.queries.length, 'role')}`
    : report.newLeads === 0
      ? single ? `No new jobs at ${single}` : 'No new jobs this time'
      : single
        ? `${plural(report.newLeads, 'new job')} at ${single}`
        : `${plural(report.newLeads, 'new job')} from ${plural(withJobs, 'company', 'companies')}`;
  const subtitle = dryRun
    ? 'Nothing was read yet.'
    : `Read ${plural(fetched, 'opening')} ${single ? '' : `across ${plural(report.boards.length, 'company', 'companies')} `}· ${report.jobsSeen} matched your roles`;

  const rows = allRows ? report.boards : report.boards.slice(0, FIRST_ROWS);
  const hasMore =
    dropped.length > 0 || search?.ran || noSource.length > 0 || recentlyCrawled.length > 0 ||
    report.rerankedExisting > 0 || report.companiesRegistered > 0 || unknownLocation > 0 || report.creditsUsed > 0;

  return (
    <section className={styles.card} aria-label="Search results">
      <div className={styles.head}>
        <span className={`${styles.headIcon} ${report.newLeads ? '' : styles.headIconQuiet}`} aria-hidden="true">
          <Icon name={report.newLeads ? 'sparkles' : 'search'} size={18} />
        </span>
        <div className={styles.headText}>
          <h2 className={styles.title}>{title}</h2>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
        {onClose && (
          <button type="button" className={styles.close} onClick={onClose} aria-label="Hide search results">
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      {!dryRun && (
        <div className={styles.stats}>
          <Stat value={fetched} label="Openings read" />
          <Stat value={report.jobsSeen} label="Matched your roles" />
          <Stat value={report.newLeads} label="New in your list" good={report.newLeads > 0} />
          <Stat value={report.skippedAlreadySeen} label="Already in your list" />
        </div>
      )}

      {report.boards.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>{single ? 'Where it looked' : 'Companies'}</h3>
          <div className={styles.rows}>
            {rows.map((b) => {
              const tone = b.error ? 'Bad' : b.kept > 0 ? 'Good' : b.warnings?.length ? 'Warn' : '';
              const status = dryRun
                ? 'Not read'
                : b.error
                  ? 'Couldn’t read'
                  : b.kept > 0
                    ? `${b.kept} new`
                    : b.openings === 0
                      ? 'No openings'
                      : 'Nothing new';
              const detail = b.error ?? (dryRun ? '' : [plural(b.openings, 'opening') + ' read', ...(b.warnings ?? [])].join(' · '));
              return (
                <div key={`${b.ats}:${b.slug}`} className={styles.row}>
                  <span className={`${styles.dot} ${tone ? styles[`dot${tone}`] : ''}`} aria-hidden="true" />
                  <div className={styles.rowMain}>
                    <div className={styles.rowName}>
                      {b.company}
                      <span className={styles.source}>{b.ats === 'linkedin-company' ? 'LinkedIn' : b.ats}</span>
                      {b.via === 'search' && <span className={styles.source}>open search</span>}
                    </div>
                    {detail && <div className={styles.rowDetail}>{detail}</div>}
                  </div>
                  <span className={`${styles.rowStatus} ${tone ? styles[`rowStatus${tone}`] : ''}`}>{status}</span>
                </div>
              );
            })}
          </div>
          {report.boards.length > FIRST_ROWS && (
            <button type="button" className={styles.showAll} onClick={() => setAllRows((v) => !v)}>
              {allRows ? 'Show fewer' : `Show all ${report.boards.length}`}
            </button>
          )}
        </div>
      )}

      {report.queries.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>
            Roles it looked for{report.planSource === 'profile' ? ' · from your profile' : ''}
          </h3>
          <div className={styles.chips}>
            {report.queries.map((q) => (
              <span key={q.query} className={`${styles.chip} ${q.hits > 0 ? styles.chipHit : ''}`}>
                {q.query}
                {!dryRun && <span className={styles.chipCount}>{q.hits}</span>}
              </span>
            ))}
          </div>
          <p className={styles.hint}>Dismiss a few jobs below and the next search narrows.</p>
        </div>
      )}

      {(report.notes.length > 0 || report.errors.length > 0) && (
        <ul className={styles.notes}>
          {report.errors.map((e) => (
            <li key={`${e.where}:${e.error}`} className={`${styles.note} ${styles.noteBad}`}>
              <Icon name="alert" size={14} />
              <span><strong>{e.where}:</strong> {e.error}</span>
            </li>
          ))}
          {report.notes.map((n) => (
            <li key={n} className={styles.note}>
              <Icon name="alert" size={14} />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}

      {!dryRun && hasMore && (
        <details className={styles.more}>
          <summary>
            More detail <Icon name="chevron" size={14} />
          </summary>
          <div className={styles.moreBody}>
            {/* A filter that is too strict hides jobs silently; the titles it dropped are how you notice. */}
            {dropped.length > 0 && (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>What the filters left out</h3>
                <div className={styles.rows}>
                  {dropped.map((d) => (
                    <div key={d.label} className={styles.row}>
                      <span className={styles.dot} aria-hidden="true" />
                      <div className={styles.rowMain}>
                        <div className={styles.rowName}>{d.label}</div>
                        {d.examples.length > 0 && (
                          <div className={styles.rowDetail}>e.g. {d.examples.map((t) => `“${t}”`).join(', ')}</div>
                        )}
                      </div>
                      <span className={styles.rowStatus}>{d.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {search?.ran && (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>
                  Open search · {plural(search.companiesFound, 'company', 'companies')} beyond the list
                </h3>
                <div className={styles.chips}>
                  {search.queries.map((q) => (
                    <span key={q.query} className={styles.chip}>
                      {q.query} <span className={styles.chipCount}>{q.hits}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Not an error: listed, but nobody has pointed them at a careers API or page yet. */}
            {noSource.length > 0 && (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>No careers source set up</h3>
                <p className={styles.hint}>{noSource.join(', ')}</p>
              </div>
            )}

            {/* Read in the last 4 hours; their postings are already in the list from that read. */}
            {recentlyCrawled.length > 0 && (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Skipped, read in the last 4 hours</h3>
                <p className={styles.hint}>
                  {recentlyCrawled
                    .map((r) => `${r.company} (${new Date(r.crawledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`)
                    .join(', ')}
                </p>
              </div>
            )}

            <p className={styles.hint}>
              {[
                report.deepScored > 0 && `${plural(report.deepScored, 'job')} read in full by the model`,
                unknownLocation > 0 && `${unknownLocation} kept with location unknown`,
                report.companiesRegistered > 0 && `${plural(report.companiesRegistered, 'company', 'companies')} added to your watch list`,
                report.rerankedExisting > 0 && `${plural(report.rerankedExisting, 'job')} already in your list re-ranked`,
                report.creditsUsed > 0 && `${report.creditsUsed} search credits used`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </details>
      )}
    </section>
  );
}

function Stat({ value, label, good }: { value: number; label: string; good?: boolean }) {
  return (
    <div className={`${styles.stat} ${good ? styles.statGood : ''}`}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}
