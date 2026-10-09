'use client';

import { useState } from 'react';
import { Icon } from '../../../components/Icon';
import type { Lead } from '../types';

export function LeadCard({
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
  // Saved with a run attached: the run is still going, so Apply again makes no sense.
  const processing = lead.status === 'SHORTLISTED' && !!lead.applicationId;
  const actionable = !processing && (lead.status === 'NEW' || lead.status === 'SHORTLISTED');

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
          <a href={`/jobs/${lead.id}`} target="_blank" rel="noopener" className="jc-title">
            {lead.title}
          </a>
          <div className="jc-meta">
            <span className="jc-company"><Icon name="building" size={14} />{lead.companyName}</span>
            {lead.location ? (
              <span><Icon name="pin" size={14} />{lead.location}</span>
            ) : (
              !lead.remote && (
                <span className="muted" title="The posting does not say where it is, so it may not be in the country you searched">
                  <Icon name="pin" size={14} />Location unknown
                </span>
              )
            )}
            {lead.remote && <span className="jc-chip"><Icon name="globe" size={12} />Remote</span>}
            {lead.experience && (
              <span className="jc-chip" title={`From the description: “${lead.experience.quote}”`}>
                <Icon name="clock" size={12} />
                {lead.experience.max ? `${lead.experience.min}–${lead.experience.max}` : `${lead.experience.min}+`} yrs exp
              </span>
            )}
            <LeetcodeSignals lead={lead} />
            {lead.autoApply === false && (
              <span className="jc-chip" title="The app has no form-filler for this site: expect to finish this one yourself">
                Apply by hand
              </span>
            )}
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
          <a href={`/jobs/${lead.id}`} target="_blank" rel="noopener" className="btn jc-btn" title="Everything about this job on one page">
            <Icon name="eye" size={15} />View details
          </a>
          {actionable ? (
            <button className="primary jc-btn jc-apply" disabled={busy} onClick={onApply}>
              <Icon name="send" size={15} />Apply
              <Icon name="arrowRight" size={15} className="jc-arrow" />
            </button>
          ) : processing ? (
            <a href={`/applications/${lead.applicationId}`} target="_blank" rel="noopener" className="btn jc-btn" title="The application run for this job">
              <Icon name="clock" size={15} />Processing
            </a>
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
          <Icon name="calendar" size={13} /> Posted {fullDate(posted)} ({ago(posted)})
          {stale && <em> · older posting</em>}
        </span>
      )}
      {found && (
        <span title={`Found by Job Applier ${found.toLocaleString()}`}>
          <Icon name="clock" size={13} /> Found {fullDate(found)}
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

/** Always with the year: "Sep 23, 2026". A date without one is ambiguous a few months later. */
function fullDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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

/**
 * What people reported on LeetCode about this company, never an estimate.
 * Each chip links to the posts it summarises; no reports, no chip.
 */
function LeetcodeSignals({ lead }: { lead: Lead }) {
  const pay = lead.pay;
  const payLinks = (lead.leetcode ?? []).filter((l) => l.kind === 'pay');
  const interviewLinks = (lead.leetcode ?? []).filter((l) => l.kind === 'interview');
  const list = (links: typeof payLinks) => links.map((l) => `${l.date} · ${l.title}`).join('\n');
  const base = pay?.baseMedian != null ? `base ~${pay.baseMedian} LPA` : null;
  const total = pay?.totalMedian != null ? `total ~${pay.totalMedian} LPA` : null;
  return (
    <>
      {(base || total) && (
        <a
          className="jc-chip"
          href={payLinks[0]?.url}
          target="_blank"
          rel="noreferrer"
          title={`Median of what people reported on LeetCode for ${lead.companyName} (any level):\n${list(payLinks)}`}
        >
          <Icon name="wallet" size={12} />
          {[base, total].filter(Boolean).join(' · ')} · {Math.max(pay!.baseReports, pay!.totalReports)} report
          {Math.max(pay!.baseReports, pay!.totalReports) === 1 ? '' : 's'}
        </a>
      )}
      {lead.interviews90d ? (
        <a
          className="jc-chip"
          href={interviewLinks[0]?.url}
          target="_blank"
          rel="noreferrer"
          title={`Interview-experience posts on LeetCode naming ${lead.companyName}, last 90 days:\n${list(interviewLinks)}`}
        >
          <Icon name="message" size={12} />
          {lead.interviews90d} interview post{lead.interviews90d === 1 ? '' : 's'} (90d)
        </a>
      ) : null}
    </>
  );
}
