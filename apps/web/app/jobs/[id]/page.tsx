'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../../lib/api';

/**
 * One job, everything about it.
 *
 * Each feature in this app grew its own page, which left the thing they all
 * describe — a single job at a single company — split across five of them.
 * This is the join: the score and why, what the application actually contains,
 * where the interviews got to, and how it ended. Read top to bottom it answers
 * "how is this one going?" without opening anything else.
 */

interface Detail {
  job: {
    title: string;
    company: string;
    location: string | null;
    remote: boolean;
    url: string;
    ats: string;
    postedAt: string | null;
    descriptionText: string | null;
  };
  match: {
    score: number;
    deepScored: boolean;
    verdict: string | null;
    seniorityFit: string | null;
    forIt: string[];
    againstIt: string[];
    dealbreaker: string | null;
    likedTerms: string[];
    dislikedTerms: string[];
  } | null;
  lead: { id: string; status: string; rejectReason: string | null; rejectCategory: string | null } | null;
  application: {
    id: string;
    status: string;
    blockedReason: string | null;
    outcome: string;
    outcomeAt: string | null;
    outcomeNote: string | null;
    submittedAt: string | null;
    confirmation: string | null;
    notes: string | null;
    coverLetter: { present: boolean; words: number };
    resume:
      | { tailored: true; label: string; coverage: number; insertions: number; unsupported: number }
      | { tailored: false };
    fields: {
      total: number;
      fromProfile: number;
      fromMemory: number;
      written: number;
      inferred: number;
      asked: number;
      skipped: number;
      failed: number;
      needsYou: number;
    };
  } | null;
  rounds: {
    id: string;
    name: string;
    status: string;
    format: string | null;
    scheduledAt: string | null;
    completedAt: string | null;
    interviewers: string | null;
    notes: string | null;
    questions: { id: string; question: string; myAnswer: string | null; selfRating: string | null; category: string | null }[];
  }[];
  lessons: { id: string; text: string; category: string | null; roundId: string | null }[];
  nextAction: { label: string; href: string; urgent: boolean } | null;
}

export default function JobPage() {
  const params = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setD(await api<Detail>(`/api/jobs/${params.id}`));
  }, [params.id]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  if (error) {
    return (
      <div className="panel">
        <h2>Cannot load this job</h2>
        <div className="notice bad">{error}</div>
      </div>
    );
  }
  if (!d) return <div className="panel muted">Loading…</div>;

  return (
    <>
      <Header d={d} />
      <MatchPanel d={d} />
      <ApplicationPanel d={d} />
      <InterviewPanel d={d} />
      <OutcomePanel d={d} />
    </>
  );
}

function Header({ d }: { d: Detail }) {
  return (
    <div className="panel">
      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: '1.5rem', margin: 0, letterSpacing: '-.01em' }}>{d.job.title}</h1>
          <div className="row" style={{ gap: '.5rem', marginTop: '.25rem' }}>
            <strong>{d.job.company || 'Unknown company'}</strong>
            {d.job.location && <span className="muted small">{d.job.location}</span>}
            {d.job.remote && <span className="src">remote</span>}
            <span className="src">{d.job.ats}</span>
          </div>
        </div>
        <div className="row" style={{ flex: 'none', gap: '.5rem' }}>
          {d.job.url && (
            <a href={d.job.url} target="_blank" rel="noreferrer">
              <button>Open posting</button>
            </a>
          )}
          {d.nextAction && (
            <a href={d.nextAction.href}>
              <button className={d.nextAction.urgent ? 'primary' : undefined}>
                {d.nextAction.label}
              </button>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function MatchPanel({ d }: { d: Detail }) {
  if (!d.match) return null;
  const m = d.match;
  const tone = m.score >= 70 ? 'var(--good)' : m.score >= 45 ? 'var(--warn)' : 'var(--bad)';

  return (
    <div className="panel">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Match</h2>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '2rem', fontWeight: 650, color: tone, lineHeight: 1 }}>
            {m.score}%
          </div>
          <div className="muted small">
            {m.verdict ? m.verdict.replace(/_/g, ' ').toLowerCase() : 'keyword score only'}
            {m.seniorityFit && m.seniorityFit !== 'UNCLEAR' && ` · seniority ${m.seniorityFit.toLowerCase()}`}
          </div>
        </div>
      </div>

      {m.dealbreaker && (
        <div className="notice bad" style={{ marginTop: '.7rem' }}>
          <strong>Blocker:</strong> {m.dealbreaker}
        </div>
      )}

      {!m.deepScored && (
        <p className="small muted" style={{ marginTop: '.6rem' }}>
          Ranked on keywords alone — no model has read the description yet. Re-score it from the
          Find work page for a real assessment.
        </p>
      )}

      <div className="grid2" style={{ marginTop: '.8rem' }}>
        <Points title="Why it fits" items={m.forIt} marker="✓" colour="var(--good)" fallbackTerms={m.likedTerms} />
        <Points title="Gaps and concerns" items={m.againstIt} marker="△" colour="var(--warn)" fallbackTerms={m.dislikedTerms} />
      </div>
    </div>
  );
}

function Points({
  title,
  items,
  marker,
  colour,
  fallbackTerms,
}: {
  title: string;
  items: string[];
  marker: string;
  colour: string;
  fallbackTerms: string[];
}) {
  const list = items.length ? items : fallbackTerms;
  if (!list.length) return <div />;
  return (
    <div>
      <div className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {title}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '.35rem 0 0' }}>
        {list.map((t) => (
          <li key={t} className="small" style={{ padding: '.15rem 0' }}>
            <span style={{ color: colour, marginRight: '.4rem' }}>{marker}</span>
            {t}
          </li>
        ))}
      </ul>
      {!items.length && (
        <div className="muted small" style={{ marginTop: '.3rem', opacity: 0.75 }}>
          Matched keywords, not a read of the posting.
        </div>
      )}
    </div>
  );
}

function ApplicationPanel({ d }: { d: Detail }) {
  const a = d.application;

  if (!a) {
    return (
      <div className="panel">
        <h2>Application</h2>
        <p className="sub" style={{ margin: 0 }}>
          Not started.{' '}
          {d.lead?.status === 'REJECTED'
            ? `You turned this one down${d.lead.rejectReason ? `: “${d.lead.rejectReason}”` : '.'}`
            : 'Apply from the Find work queue and the filled form will show up here.'}
        </p>
      </div>
    );
  }

  const f = a.fields;
  return (
    <div className="panel">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Application</h2>
        <span className={`pill ${a.status}`}>{a.status.replace(/_/g, ' ').toLowerCase()}</span>
      </div>

      {a.blockedReason && (
        <div className="notice bad" style={{ marginTop: '.6rem' }}>
          {a.blockedReason}
        </div>
      )}

      <Line
        label="Resume"
        ok={a.resume.tailored}
        value={
          a.resume.tailored
            ? `Tailored — ${a.resume.insertions} addition${a.resume.insertions === 1 ? '' : 's'}, ${a.resume.coverage}% keyword coverage`
            : 'Base resume, not tailored for this job'
        }
        note={
          a.resume.tailored
            ? a.resume.unsupported > 0
              ? `${a.resume.unsupported} keyword${a.resume.unsupported === 1 ? '' : 's'} the job wants could not be grounded in your material, so ${a.resume.unsupported === 1 ? 'it was' : 'they were'} left out`
              : 'Every addition is backed by something already in your material'
            : undefined
        }
      />

      <Line
        label="Cover letter"
        ok={a.coverLetter.present}
        value={a.coverLetter.present ? `Generated — ${a.coverLetter.words} words` : 'None generated'}
      />

      <Line
        label="Questions"
        ok={f.needsYou === 0}
        value={
          f.total
            ? `${f.total} field${f.total === 1 ? '' : 's'} filled`
            : 'The form has not been read yet'
        }
        note={
          f.total
            ? [
                f.fromProfile && `${f.fromProfile} from your profile`,
                f.fromMemory && `${f.fromMemory} from remembered answers`,
                f.written && `${f.written} written for this employer`,
                f.inferred && `${f.inferred} inferred`,
                f.asked && `${f.asked} you answered`,
                f.skipped && `${f.skipped} skipped`,
                f.failed && `${f.failed} failed to fill`,
              ]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
        warn={f.needsYou > 0 ? `${f.needsYou} still needs you` : undefined}
      />

      <div className="row" style={{ marginTop: '.8rem', gap: '.5rem' }}>
        <a href={`/applications/${a.id}`}>
          <button className={f.needsYou > 0 || a.status === 'REVIEW' ? 'primary' : undefined}>
            {a.status === 'REVIEW' ? 'Review and submit' : 'Open the run'}
          </button>
        </a>
        <a href="/resume">
          <button>{a.resume.tailored ? 'Re-tailor resume' : 'Tailor resume'}</button>
        </a>
      </div>
    </div>
  );
}

function Line({
  label,
  ok,
  value,
  note,
  warn,
}: {
  label: string;
  ok: boolean;
  value: string;
  note?: string;
  warn?: string;
}) {
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '.6rem 0' }}>
      <div className="row" style={{ gap: '.5rem', alignItems: 'baseline' }}>
        <span style={{ color: ok ? 'var(--good)' : 'var(--muted)' }}>{ok ? '✓' : '○'}</span>
        <strong className="small">{label}</strong>
        <span className="small">{value}</span>
      </div>
      {note && (
        <div className="muted small" style={{ marginLeft: '1.4rem' }}>
          {note}
        </div>
      )}
      {warn && (
        <div className="small" style={{ marginLeft: '1.4rem', color: 'var(--warn)' }}>
          ⚠ {warn}
        </div>
      )}
    </div>
  );
}

function InterviewPanel({ d }: { d: Detail }) {
  if (!d.application) return null;
  const rounds = d.rounds;

  return (
    <div className="panel">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Interviews</h2>
        <a href="/tracker">
          <button>{rounds.length ? 'Edit in tracker' : 'Add a round'}</button>
        </a>
      </div>

      {!rounds.length ? (
        <p className="sub" style={{ margin: '.4rem 0 0' }}>
          Nothing logged yet. Add rounds as they are scheduled and the questions you were asked —
          the Retrospective page finds the ones several companies keep asking.
        </p>
      ) : (
        rounds.map((r) => (
          <div key={r.id} style={{ borderTop: '1px solid var(--border)', padding: '.6rem 0' }}>
            <div className="row" style={{ gap: '.5rem' }}>
              <span style={{ color: dotColour(r.status) }}>{dot(r.status)}</span>
              <strong className="small">{r.name}</strong>
              <span className="muted small">{r.status.replace(/_/g, ' ').toLowerCase()}</span>
              {r.format && <span className="src">{r.format}</span>}
              {r.scheduledAt && (
                <span className="muted small">{new Date(r.scheduledAt).toLocaleDateString()}</span>
              )}
            </div>
            {r.questions.length > 0 && (
              <ul style={{ margin: '.35rem 0 0 1.4rem', padding: 0 }}>
                {r.questions.map((q) => (
                  <li key={q.id} className="small" style={{ padding: '.1rem 0' }}>
                    {q.question}
                    {q.selfRating && (
                      <span className="muted"> — you rated your answer {q.selfRating.toLowerCase()}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}

      {d.lessons.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '.6rem', marginTop: '.4rem' }}>
          <div className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>
            What you noted afterwards
          </div>
          {d.lessons.map((l) => (
            <div key={l.id} className="small" style={{ padding: '.15rem 0' }}>
              {l.category && <span className="src">{l.category}</span>} {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const dot = (status: string) =>
  status === 'PASSED' ? '✓' : status === 'FAILED' ? '✕' : status === 'CANCELLED' ? '–' : '○';
const dotColour = (status: string) =>
  status === 'PASSED' ? 'var(--good)' : status === 'FAILED' ? 'var(--bad)' : 'var(--muted)';

function OutcomePanel({ d }: { d: Detail }) {
  const a = d.application;
  if (!a) return null;

  return (
    <div className="panel">
      <h2>Outcome</h2>
      <div className="row" style={{ gap: '2rem', flexWrap: 'wrap' }}>
        <Fact
          label="Applied"
          value={a.submittedAt ? new Date(a.submittedAt).toLocaleDateString() : 'not yet'}
        />
        <Fact label="Response" value={a.outcome.replace(/_/g, ' ').toLowerCase()} />
        {a.outcomeAt && <Fact label="Updated" value={new Date(a.outcomeAt).toLocaleDateString()} />}
      </div>
      {a.confirmation && (
        <p className="small muted" style={{ marginTop: '.6rem' }}>
          Confirmation seen on the page: “{a.confirmation}”
        </p>
      )}
      {a.outcomeNote && (
        <p className="small" style={{ marginTop: '.4rem' }}>
          {a.outcomeNote}
        </p>
      )}
      {a.notes && (
        <p className="small muted" style={{ marginTop: '.4rem' }}>
          {a.notes}
        </p>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}
