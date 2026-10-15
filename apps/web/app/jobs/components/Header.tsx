'use client';

import React from 'react';
import { Detail } from './types';
import s from '../job.module.css';

export function Header({
  d,
  onReject,
  onApply,
  applying,
  applyError,
}: {
  d: Detail;
  onReject?: () => void;
  /** Starts a run that fills the form - not a link to the posting. */
  onApply?: () => void;
  applying?: boolean;
  applyError?: string | null;
}) {
  // Apply starts a new run, so offer it only when there is no live one: none
  // yet, or the last one died. Otherwise the next action is the way forward.
  const runStatus = d.application?.status;
  const canApply = !runStatus || runStatus === 'FAILED' || runStatus === 'CANCELLED';
  // "Triage this lead" and the shortlist's "Apply" only link back to the
  // queue, to make the same apply-or-reject call these buttons already make.
  const nextAction = onApply && d.nextAction?.href === '/discover' ? null : d.nextAction;
  const company = d.job.company || 'Unknown company';
  return (
    <section className={s.card}>
      <div className={s.hero}>
        <div className={s.monogram} aria-hidden>
          {company.trim().charAt(0).toUpperCase() || '?'}
        </div>
        <div className={s.heroMain}>
          <h1>{d.job.title}</h1>
          <div className={s.company}>{company}</div>
          <div className={s.chips}>
            {d.job.location && <span className={s.chip}>{d.job.location}</span>}
            {d.job.remote && <span className={`${s.chip} ${s.chipGood}`}>Remote</span>}
            {d.job.postedAt && (
              <span className={s.chip}>Posted {new Date(d.job.postedAt).toLocaleDateString()}</span>
            )}
            <span className={s.chip}>via {d.job.ats}</span>
          </div>
        </div>
      </div>

      <div className={s.actions}>
        {nextAction && (
          <a href={nextAction.href}>
            <button className={`${s.pill} ${nextAction.urgent ? 'primary' : ''}`}>{nextAction.label}</button>
          </a>
        )}
        {d.job.url && onApply && canApply && (
          <button className={`${s.pill} ${nextAction?.urgent ? '' : 'primary'}`} onClick={onApply} disabled={applying}>
            {applying ? 'Starting…' : runStatus ? 'Try again' : 'Apply'}
          </button>
        )}
        {d.job.url && (
          <a href={d.job.url} target="_blank" rel="noreferrer">
            <button className={s.pill}>Open posting ↗</button>
          </a>
        )}
        {d.lead && d.lead.status !== 'REJECTED' && onReject && (
          <button className={s.quiet} onClick={onReject}>Not for me</button>
        )}
      </div>
      {applyError && <div className={`notice bad ${s.message}`}>{applyError}</div>}

      <Journey d={d} />
    </section>
  );
}

type Tone = 'good' | 'warn' | 'bad' | 'accent' | 'todo';

/** Where this job has got to, read straight off the data below. */
function Journey({ d }: { d: Detail }) {
  const a = d.application;
  const rejected = d.lead?.status === 'REJECTED';
  const outcomeDone = a && a.outcome !== 'IN_PROGRESS';
  const goodOutcome = a && (a.outcome === 'OFFER' || a.outcome === 'ACCEPTED');
  const passed = d.rounds.filter((r) => r.status === 'PASSED').length;

  const steps: { name: string; detail: string; tone: Tone }[] = [
    {
      name: 'Matched',
      detail: d.match ? `${d.match.score}% ${d.match.deepScored ? 'fit' : 'keyword score'}` : 'Not scored',
      tone: d.match ? 'good' : 'todo',
    },
    {
      name: 'Applied',
      detail: a?.submittedAt
        ? new Date(a.submittedAt).toLocaleDateString()
        : a
          ? a.status.replace(/_/g, ' ').toLowerCase()
          : rejected
            ? 'You passed on it'
            : 'Not started',
      tone: a?.submittedAt ? 'good' : a ? (a.status === 'FAILED' ? 'bad' : 'warn') : rejected ? 'bad' : 'todo',
    },
    {
      name: 'Interviews',
      detail: d.rounds.length
        ? `${d.rounds.length} round${d.rounds.length === 1 ? '' : 's'}${passed ? ` · ${passed} passed` : ''}`
        : 'None yet',
      tone: d.rounds.length ? (outcomeDone ? 'good' : 'accent') : 'todo',
    },
    {
      name: 'Outcome',
      detail: outcomeDone ? a.outcome.replace(/_/g, ' ').toLowerCase() : 'Waiting',
      tone: outcomeDone ? (goodOutcome ? 'good' : 'bad') : 'todo',
    },
  ];

  const dotClass: Record<Tone, string | undefined> = {
    good: s.dotGood,
    warn: s.dotWarn,
    bad: s.dotBad,
    accent: s.dotAccent,
    todo: '',
  };

  return (
    <div className={s.journey}>
      {steps.map((step) => (
        <div key={step.name} className={`${s.step} ${step.tone === 'todo' ? s.stepTodo : ''}`}>
          <span className={`${s.dot} ${dotClass[step.tone]}`} />
          <div style={{ minWidth: 0 }}>
            <div className={s.stepName}>{step.name}</div>
            <div className={s.stepDetail}>{step.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default Header;
