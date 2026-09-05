'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../../lib/api';
import Header from '../components/Header';
import { Loading } from '../../../components/Loading';
import type { Detail } from '../components/types';

/**
 * One job, everything about it.
 *
 * Each feature in this app grew its own page, which left the thing they all
 * describe — a single job at a single company — split across five of them.
 * This is the join: the score and why, what the application actually contains,
 * where the interviews got to, and how it ended. Read top to bottom it answers
 * "how is this one going?" without opening anything else.
 */

export default function JobPage() {
  const params = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null); // page-load errors
  const [rescoreError, setRescoreError] = useState<string | null>(null); // rescore-only errors
  const [rescoreBusy, setRescoreBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);

  const load = useCallback(async () => {
    setError(null);
    setD(await api<Detail>(`/api/jobs/${params.id}`));
  }, [params.id]);

  const handleRescore = useCallback(async () => {
    setRescoreError(null);
    setRescoreBusy(true);
    try {
      await api(`/api/leads/${params.id}/rescore`, { method: 'POST' });
      await load();
    } catch (e) {
      setRescoreError((e as Error).message);
    } finally {
      setRescoreBusy(false);
    }
  }, [load]);

  const handleReject = useCallback(async (category?: string, reason?: string) => {
    try {
      await api(`/api/leads/${params.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ category, reason }),
      });
      await load();
      setRejecting(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [params.id, load]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
    api('/api/sources')
      .then((d) => {
        const dd = d as { sources: { id: string; handleHint: string }[]; rejectCategories: string[]; searchConfigured: boolean };
        setCategories(dd.rejectCategories);
      })
      .catch(() => {});
  }, [load]);

  if (error) {
    return (
      <div className="panel">
        <h2>Cannot load this job</h2>
        <div className="notice bad">{error}</div>
      </div>
    );
  }
  if (!d) return <Loading />;

  return (
    <>
      <Header d={d} onReject={() => setRejecting(true)} />
      <MatchPanel d={d} busy={rescoreBusy} onRescore={handleRescore} rescoreError={rescoreError} />
      <ApplicationPanel d={d} />
      <InterviewPanel d={d} />
      <OutcomePanel d={d} />
      {rejecting && d.lead && (
        <RejectDialog
          title={d.job.title}
          companyName={d.job.company}
          categories={categories}
          onClose={() => setRejecting(false)}
          onDone={handleReject}
        />
      )}
    </>
  );
}

function RejectDialog({
  title,
  companyName,
  categories,
  onClose,
  onDone,
}: {
  title: string;
  companyName: string;
  categories: string[];
  onClose: () => void;
  onDone: (category?: string, reason?: string) => Promise<void>;
}) {
  const [category, setCategory] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await onDone(category, reason.trim() || undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2 style={{ margin: '0 0 .2rem' }}>Not for you</h2>
        <p className="sub">{title} at {companyName}. A reason is optional and helps improve future ranking.</p>
        <div className="row" style={{ marginBottom: '.8rem' }}>
          {categories.map((value) => (
            <button
              key={value}
              onClick={() => setCategory(category === value ? undefined : value)}
              style={category === value ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--accent)' } : undefined}
            >
              {value}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Anything else? (optional)</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="row">
          <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Reject'}</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}



function MatchPanel({ d, busy, onRescore, rescoreError }: { d: Detail; busy: boolean; onRescore: () => void; rescoreError?: string | null }) {
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
            <div style={{ marginTop: '.25rem', fontSize: '.8rem' }}>
              {m.scoreSource === 'MODEL' || m.deepScored ? (
                <span>
                  Model assessment{m.evaluatedAt ? ` · ${new Date(m.evaluatedAt).toLocaleString()}` : ''}
                </span>
              ) : (
                <span>Preliminary keyword match</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {m.dealbreaker && (
        <div className="notice bad" style={{ marginTop: '.7rem' }}>
          <strong>Blocker:</strong> {m.dealbreaker}
        </div>
      )}

      {!m.deepScored && (
        <div className="notice" style={{ marginTop: '.7rem' }}>
          <strong className="small">Counted, not read.</strong>{' '}
          <span className="small muted">
            A crawl only sends its most promising finds to a model, so this score comes from words
            the posting and your profile have in common — a weak signal, and one that boilerplate
            flatters. Rescore to have it actually read.
          </span>
        </div>
      )}

      <div style={{ marginTop: '.8rem' }}>
        <button className="primary" disabled={busy} onClick={onRescore}>
          {busy ? 'Rescoring…' : 'Rescore'}
        </button>
      </div>

      {rescoreError && <div className="notice bad" style={{ marginTop: '.6rem' }}>{rescoreError}</div>}

      <div className="grid2" style={{ marginTop: '.8rem' }}>
        <Points
          title="Why it fits"
          items={m.forIt}
          marker="✓"
          colour="var(--good)"
          fallbackTerms={m.sharedTerms?.length ? m.sharedTerms : m.likedTerms}
        />
        <Points
          title="Gaps and concerns"
          items={m.againstIt}
          marker="△"
          colour="var(--warn)"
          fallbackTerms={m.missingTerms?.length ? m.missingTerms : m.dislikedTerms}
        />
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
  // Reasons and keywords are different things and must not look the same.
  // A tick beside the word "distributed systems" reads as a considered
  // judgement; it is a word that appeared in both documents, and presenting it
  // as the former is how a lead ends up looking like it was assessed when it
  // was counted.
  if (!items.length) {
    if (!fallbackTerms.length) return <div />;
    return (
      <div>
        <div className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>
          {title === 'Why it fits' ? 'Words in common' : 'Words counting against'}
        </div>
        <p className="small muted" style={{ margin: '.35rem 0 0' }}>
          {fallbackTerms.join(' · ')}
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {title}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '.35rem 0 0' }}>
        {items.map((t) => (
          <li key={t} className="small" style={{ padding: '.15rem 0' }}>
            <span style={{ color: colour, marginRight: '.4rem' }}>{marker}</span>
            {t}
          </li>
        ))}
      </ul>
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
