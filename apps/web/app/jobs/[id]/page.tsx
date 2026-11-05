'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../../lib/api';
import Header from '../components/Header';
import { Loading } from '../../../components/Loading';
import type { Detail } from '../components/types';
import { useApplyPrefs } from '../../discover/components/ApplyPreferences';
import s from '../job.module.css';

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
  const [prefs] = useApplyPrefs();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setD(await api<Detail>(`/api/jobs/${params.id}`));
  }, [params.id]);

  // The URL id can be a job, a lead or an application; the lead routes need
  // the lead's own id.
  const leadId = d?.lead?.id;

  const handleRescore = useCallback(async () => {
    if (!leadId) return;
    setRescoreError(null);
    setRescoreBusy(true);
    try {
      await api(`/api/leads/${leadId}/rescore`, { method: 'POST' });
      await load();
    } catch (e) {
      setRescoreError((e as Error).message);
    } finally {
      setRescoreBusy(false);
    }
  }, [leadId, load]);

  // Throws on failure so the dialog can show the error and stay open.
  const handleReject = useCallback(async (category?: string, reason?: string) => {
    if (!leadId) return;
    await api(`/api/leads/${leadId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ category, reason }),
    });
    await load();
    setRejecting(false);
  }, [leadId, load]);

  // Start a run, the same way Find work and Runs do. A job reached from the
  // queue goes through its lead so the queue learns from the decision.
  const handleApply = useCallback(async () => {
    if (!d) return;
    setApplyError(null);
    setApplying(true);
    try {
      const r = d.lead
        ? await api<{ applicationId: string }>(`/api/leads/${d.lead.id}/apply`, {
            method: 'POST',
            body: JSON.stringify({ writeCoverLetter: prefs.writeCoverLetter, autoTailorResume: prefs.tailorResume }),
          })
        : await api<{ applicationId: string }>('/api/applications', {
            method: 'POST',
            body: JSON.stringify({ url: d.job.url, autoStart: true, writeCoverLetter: prefs.writeCoverLetter }),
          });
      window.location.href = `/applications/${r.applicationId}`;
    } catch (e) {
      setApplyError((e as Error).message);
      setApplying(false);
    }
  }, [d, prefs]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
    api<{ rejectCategories: string[] }>('/api/sources')
      .then((r) => setCategories(r.rejectCategories))
      .catch(() => {});
  }, [load]);

  if (error) {
    return (
      <div className={s.page}>
        <section className={s.card}>
          <h2 style={{ margin: 0 }}>Cannot load this job</h2>
          <div className={`notice bad ${s.message}`}>{error}</div>
        </section>
      </div>
    );
  }
  if (!d) return <Loading />;

  return (
    <div className={s.page}>
      <Header
        d={d}
        onReject={() => setRejecting(true)}
        onApply={handleApply}
        applying={applying}
        applyError={applyError}
      />
      <MatchPanel
        d={d}
        busy={rescoreBusy}
        onRescore={d.lead ? handleRescore : undefined}
        rescoreError={rescoreError}
      />
      <ApplicationPanel d={d} />
      <InterviewPanel d={d} />
      <OutcomePanel d={d} />
      <PostingPanel d={d} />
      {rejecting && d.lead && (
        <RejectDialog
          title={d.job.title}
          companyName={d.job.company}
          categories={categories}
          onClose={() => setRejecting(false)}
          onDone={handleReject}
        />
      )}
    </div>
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
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onDone(category, reason.trim() || undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ borderRadius: 26 }} onClick={(event) => event.stopPropagation()}>
        <h2 style={{ margin: '0 0 .2rem' }}>Not for you</h2>
        <p className="sub">{title} at {companyName}. A reason is optional and helps improve future ranking.</p>
        {categories.length > 0 && (
          <div className={s.terms} style={{ marginBottom: '.9rem' }}>
            {categories.map((value) => (
              <button
                key={value}
                className={`${s.toggle} ${category === value ? s.toggleOn : ''}`}
                aria-pressed={category === value}
                onClick={() => setCategory(category === value ? undefined : value)}
              >
                {value}
              </button>
            ))}
          </div>
        )}
        <label className="field">
          <span>Anything else? (optional)</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        {error && <div className="notice bad" style={{ marginBottom: '.7rem' }}>{error}</div>}
        <div className={s.actions} style={{ marginTop: 0 }}>
          <button className={`${s.pill} primary`} disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Reject'}</button>
          <button className={s.pill} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ---- match ------------------------------------------------------------------ */

function ScoreRing({ score, colour }: { score: number; colour: string }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * c;
  return (
    <div className={s.ring} role="img" aria-label={`${score}% match`}>
      <svg width="76" height="76" viewBox="0 0 76 76">
        <circle cx="38" cy="38" r={r} fill="none" stroke="var(--border)" strokeWidth="7" />
        <circle
          cx="38"
          cy="38"
          r={r}
          fill="none"
          stroke={colour}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c}`}
        />
      </svg>
      <div className={s.ringValue} style={{ color: colour }}>{score}%</div>
    </div>
  );
}

function MatchPanel({
  d,
  busy,
  onRescore,
  rescoreError,
}: {
  d: Detail;
  busy: boolean;
  onRescore?: () => void;
  rescoreError?: string | null;
}) {
  if (!d.match) return null;
  const m = d.match;
  const tone = m.score >= 70 ? 'var(--good)' : m.score >= 45 ? 'var(--warn)' : 'var(--bad)';
  const modelRead = m.scoreSource === 'MODEL' || m.deepScored;

  return (
    <section className={s.card}>
      <div className={s.matchHead}>
        <ScoreRing score={m.score} colour={tone} />
        <div className={s.matchMain}>
          <h2>Match</h2>
          <div className={s.verdict}>
            {m.verdict ? m.verdict.replace(/_/g, ' ').toLowerCase() : 'Keyword score only'}
            {m.seniorityFit && m.seniorityFit !== 'UNCLEAR' && (
              <span className={s.hint} style={{ fontWeight: 400 }}> · seniority {m.seniorityFit.toLowerCase()}</span>
            )}
          </div>
          <div className={s.hint}>
            {modelRead
              ? `Model assessment${m.evaluatedAt ? ` · ${new Date(m.evaluatedAt).toLocaleString()}` : ''}`
              : 'Preliminary keyword match'}
          </div>
        </div>
        {onRescore && (
          <button className={s.pill} disabled={busy} onClick={onRescore}>
            {busy ? 'Rescoring…' : modelRead ? 'Rescore' : 'Have it read'}
          </button>
        )}
      </div>

      {m.dealbreaker && (
        <div className={`${s.callout} ${s.calloutBad}`}>
          <span><strong>Blocker:</strong> {m.dealbreaker}</span>
        </div>
      )}

      {!m.deepScored && (
        <div className={s.callout}>
          <span>
            <strong>Counted, not read.</strong> A crawl only sends its most promising finds to a
            model, so this score comes from words the posting and your profile have in common — a
            weak signal, and one that boilerplate flatters. Rescore to have it actually read.
          </span>
        </div>
      )}

      {rescoreError && <div className={`notice bad ${s.message}`}>{rescoreError}</div>}

      <div className={s.columns}>
        <Points
          title="Why it fits"
          items={m.forIt}
          marker="✓"
          colour="var(--good)"
          fallbackTitle="Words in common"
          fallbackTerms={m.sharedTerms?.length ? m.sharedTerms : m.likedTerms}
        />
        <Points
          title="Gaps and concerns"
          items={m.againstIt}
          marker="△"
          colour="var(--warn)"
          fallbackTitle="Words counting against"
          fallbackTerms={m.missingTerms?.length ? m.missingTerms : m.dislikedTerms}
        />
      </div>
    </section>
  );
}

function Points({
  title,
  items,
  marker,
  colour,
  fallbackTitle,
  fallbackTerms,
}: {
  title: string;
  items: string[];
  marker: string;
  colour: string;
  fallbackTitle: string;
  fallbackTerms: string[];
}) {
  // Reasons and keywords are different things and must not look the same.
  // A tick beside the word "distributed systems" reads as a considered
  // judgement; it is a word that appeared in both documents, and presenting it
  // as the former is how a lead ends up looking like it was assessed when it
  // was counted. So keywords get plain neutral chips, never a marker.
  if (!items.length) {
    if (!fallbackTerms.length) return null;
    return (
      <div>
        <div className={s.label}>{fallbackTitle}</div>
        <div className={s.terms}>
          {fallbackTerms.map((t, i) => (
            <span key={`${t}-${i}`} className={s.chip}>{t}</span>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className={s.label}>{title}</div>
      <ul className={s.points}>
        {items.map((t, i) => (
          <li key={`${t}-${i}`}>
            <span className={s.mark} style={{ color: colour }}>{marker}</span>
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---- application ------------------------------------------------------------ */

function ApplicationPanel({ d }: { d: Detail }) {
  const a = d.application;

  if (!a) {
    return (
      <section className={s.card}>
        <div className={s.cardHead} style={{ marginBottom: 'var(--space-3)' }}>
          <h2>Application</h2>
        </div>
        <div className={s.empty}>
          Not started.{' '}
          {d.lead?.status === 'REJECTED'
            ? `You turned this one down${d.lead.rejectReason ? `: “${d.lead.rejectReason}”` : '.'}`
            : 'Press Apply above and the filled form will show up here.'}
        </div>
      </section>
    );
  }

  const f = a.fields;
  const fieldNote = [
    f.fromProfile && `${f.fromProfile} from your profile`,
    f.fromMemory && `${f.fromMemory} from remembered answers`,
    f.written && `${f.written} written for this employer`,
    f.inferred && `${f.inferred} inferred`,
    f.asked && `${f.asked} you answered`,
    f.skipped && `${f.skipped} skipped`,
    f.failed && `${f.failed} failed to fill`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <h2>Application</h2>
        <span className={`pill ${a.status}`}>{a.status.replace(/_/g, ' ').toLowerCase()}</span>
      </div>

      {a.blockedReason && (
        <div className={`${s.callout} ${s.calloutWarn}`} style={{ marginTop: 0, marginBottom: 'var(--space-3)' }}>
          <span>{a.blockedReason}</span>
        </div>
      )}

      <div className={s.list}>
        <Row
          name="Resume"
          tone={a.resume.tailored ? 'good' : 'todo'}
          status={a.resume.tailored ? 'Tailored' : 'Base resume'}
          meta={
            a.resume.tailored
              ? `${a.resume.insertions} addition${a.resume.insertions === 1 ? '' : 's'}, ${a.resume.coverage}% keyword coverage. ${
                  a.resume.unsupported > 0
                    ? `${a.resume.unsupported} keyword${a.resume.unsupported === 1 ? '' : 's'} the job wants could not be grounded in your material, so ${a.resume.unsupported === 1 ? 'it was' : 'they were'} left out.`
                    : 'Every addition is backed by something already in your material.'
                }`
              : 'Not tailored for this job'
          }
        />
        <Row
          name="Cover letter"
          tone={a.coverLetter.present ? 'good' : 'todo'}
          status={a.coverLetter.present ? `${a.coverLetter.words} words` : 'None'}
          meta={a.coverLetter.present ? 'Generated for this job' : 'None generated'}
        />
        <Row
          name="Questions"
          tone={f.needsYou > 0 ? 'warn' : f.total ? 'good' : 'todo'}
          status={
            f.needsYou > 0
              ? `${f.needsYou} need${f.needsYou === 1 ? 's' : ''} you`
              : f.total
                ? `${f.total} filled`
                : 'Not read'
          }
          meta={f.total ? fieldNote || `${f.total} field${f.total === 1 ? '' : 's'} filled` : 'The form has not been read yet'}
        />
      </div>

      <div className={s.actions}>
        <a href={`/applications/${a.id}`}>
          <button className={`${s.pill} ${f.needsYou > 0 || a.status === 'REVIEW' ? 'primary' : ''}`}>
            {a.status === 'REVIEW' ? 'Review and submit' : 'Open the run'}
          </button>
        </a>
        <a href="/resume">
          <button className={s.pill}>{a.resume.tailored ? 'Re-tailor resume' : 'Tailor resume'}</button>
        </a>
      </div>
    </section>
  );
}

type Tone = 'good' | 'warn' | 'bad' | 'todo';

const dotFor: Record<Tone, string | undefined> = { good: s.dotGood, warn: s.dotWarn, bad: s.dotBad, todo: '' };
const statusFor: Record<Tone, string | undefined> = { good: s.statusGood, warn: s.statusWarn, bad: s.statusBad, todo: '' };

function Row({
  name,
  tone,
  status,
  meta,
  children,
}: {
  name: ReactNode;
  tone: Tone;
  status?: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`${s.row} ${tone === 'warn' ? s.rowWarn : ''}`}>
      <span className={`${s.dot} ${dotFor[tone]}`} />
      <div className={s.rowMain}>
        <div className={s.rowName}>{name}</div>
        {meta && <div className={s.rowMeta}>{meta}</div>}
        {children}
      </div>
      {status && <span className={`${s.rowStatus} ${statusFor[tone]}`}>{status}</span>}
    </div>
  );
}

/* ---- interviews ------------------------------------------------------------- */

const roundTone = (status: string): Tone =>
  status === 'PASSED' ? 'good' : status === 'FAILED' ? 'bad' : status === 'CANCELLED' ? 'todo' : 'warn';

function InterviewPanel({ d }: { d: Detail }) {
  if (!d.application) return null;
  const rounds = d.rounds;

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <h2>Interviews</h2>
        <a href="/tracker">
          <button className={s.pill}>{rounds.length ? 'Edit in tracker' : 'Add a round'}</button>
        </a>
      </div>

      {!rounds.length ? (
        <div className={s.empty}>
          Nothing logged yet. Add rounds as they are scheduled and the questions you were asked —
          the Retrospective page finds the ones several companies keep asking.
        </div>
      ) : (
        <div className={s.list}>
          {rounds.map((r) => (
            <Row
              key={r.id}
              name={r.name}
              tone={roundTone(r.status)}
              status={r.status.replace(/_/g, ' ').toLowerCase()}
              meta={[r.format, r.scheduledAt && new Date(r.scheduledAt).toLocaleDateString()].filter(Boolean).join(' · ') || undefined}
            >
              {r.questions.length > 0 && (
                <ul className={s.questions}>
                  {r.questions.map((q) => (
                    <li key={q.id}>
                      {q.question}
                      {q.selfRating && (
                        <span className="muted"> — you rated your answer {q.selfRating.toLowerCase()}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Row>
          ))}
        </div>
      )}

      {d.lessons.length > 0 && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div className={s.label}>What you noted afterwards</div>
          <ul className={s.points}>
            {d.lessons.map((l) => (
              <li key={l.id}>
                {l.category && <span className={s.chip}>{l.category}</span>}
                <span>{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* ---- outcome ---------------------------------------------------------------- */

function OutcomePanel({ d }: { d: Detail }) {
  const a = d.application;
  if (!a) return null;

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <h2>Outcome</h2>
      </div>
      <div className={s.tiles}>
        <Fact label="Applied" value={a.submittedAt ? new Date(a.submittedAt).toLocaleDateString() : 'Not yet'} />
        <Fact label="Response" value={a.outcome.replace(/_/g, ' ').toLowerCase()} />
        <Fact label="Updated" value={a.outcomeAt ? new Date(a.outcomeAt).toLocaleDateString() : '—'} />
      </div>
      {a.confirmation && (
        <p className={s.note}>Confirmation seen on the page: “{a.confirmation}”</p>
      )}
      {a.outcomeNote && <p className={s.note}>{a.outcomeNote}</p>}
      {a.notes && <p className={s.note} style={{ color: 'var(--muted)' }}>{a.notes}</p>}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.tile}>
      <div className={s.tileValue}>{value}</div>
      <div className={s.tileLabel}>{label}</div>
    </div>
  );
}

/* ---- the posting ------------------------------------------------------------ */

function PostingPanel({ d }: { d: Detail }) {
  const [open, setOpen] = useState(false);
  const text = d.job.descriptionText?.trim();
  if (!text) return null;
  const long = text.length > 600;

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <h2>The posting</h2>
        {long && (
          <button className={s.pill} onClick={() => setOpen(!open)}>
            {open ? 'Show less' : 'Read it all'}
          </button>
        )}
      </div>
      <div className={`${s.description} ${long && !open ? s.clamped : ''}`}>{text}</div>
    </section>
  );
}
