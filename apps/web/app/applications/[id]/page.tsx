'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { API, api } from '../../../lib/api';
import { Loading } from '../../../components/Loading';
import {
  QuestionField,
  initialRemember,
  initialValue,
  type PendingQuestion,
} from '../../../components/QuestionField';


interface PlanRow {
  label: string;
  value: unknown;
  source: string;
  confidence: number;
  rationale?: string;
  filled: boolean;
  error?: string;
}

interface AppDetail {
  id: string;
  status: string;
  blockedReason: string | null;
  coverLetter: string | null;
  fieldPlan: PlanRow[] | null;
  confirmation: string | null;
  job: { url: string; company: string; title: string; ats: string };
  pending: PendingQuestion[];
  artifacts: { id: string; kind: string; label: string; path: string; createdAt: string }[];
}

interface Evt { type: string; message: string; at: string }

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [atWall, setAtWall] = useState(false);
  const [events, setEvents] = useState<Evt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(
    () => api<{ application: AppDetail; atWall?: boolean }>(`/api/applications/${id}`)
      .then((d) => {
        setDetail(d.application);
        setAtWall(Boolean(d.atWall));
      })
      .catch((e) => setError(e.message)),
    [id],
  );

  useEffect(() => {
    refresh();
    // The run publishes to this stream as it works; history is replayed on
    // connect so a refresh mid-run does not lose the story.
    // withCredentials, or the session cookie is not sent and the stream is
    // refused - EventSource omits cookies cross-origin by default, and the API
    // is on another origin in both development and production.
    const es = new EventSource(`${API}/api/applications/${id}/stream`, { withCredentials: true });
    es.onmessage = (m) => {
      const evt = JSON.parse(m.data) as Evt;
      setEvents((prev) => [...prev, evt]);
      if (['STATUS', 'QUESTION_ASKED', 'BLOCKED', 'ERROR'].includes(evt.type)) refresh();
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [id, refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events]);

  if (error) return <div className="panel"><div className="notice bad">{error}</div></div>;
  if (!detail) return <Loading />;

  const open = detail.pending.filter((q) => !q.answeredAt);

  return (
    <>
      <div className="panel">
        <div className="spread">
          <div>
            <h2>{detail.job.title === 'pending' ? 'Reading the posting…' : detail.job.title}</h2>
            <p className="sub" style={{ margin: 0 }}>
              {detail.job.company} · <a href={detail.job.url} target="_blank" rel="noreferrer">{detail.job.ats}</a>
            </p>
          </div>
          <div className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
            <span className={`pill ${detail.status}`}>{detail.status.replace('_', ' ')}</span>
            {(detail.status === 'FAILED' || detail.status === 'BLOCKED') && (
              <button
                className="primary"
                onClick={async () => {
                  try {
                    await api(`/api/applications/${id}/start`, { method: 'POST' });
                    refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
                style={{ fontSize: '.85rem', padding: '.3rem .6rem' }}
              >
                Resume
              </button>
            )}
          </div>
        </div>
        {/* NEEDS_HUMAN explains itself in its own panel below; saying it twice is noise. */}
        {detail.blockedReason && detail.status !== 'NEEDS_HUMAN' && (
          <div
            className={`notice ${detail.status === 'FAILED' ? 'bad' : detail.status === 'SUBMITTED' ? 'good' : ''}`}
            style={{ marginTop: '.9rem' }}
          >
            {detail.blockedReason}
          </div>
        )}
      </div>

      {detail.status === 'NEEDS_HUMAN' &&
        (atWall ? (
          <WallPanel applicationId={id} detail={detail} onDone={refresh} />
        ) : events.some((e) => e.message.startsWith('Submitting')) ? (
          <OutcomePanel applicationId={id} detail={detail} onDone={refresh} />
        ) : (
          <StoppedPanel applicationId={id} detail={detail} onDone={refresh} />
        ))}

      {/* Questions from a run that has since ended are stale: a restart re-asks them. */}
      {open.length > 0 && detail.status === 'NEEDS_INPUT' && <QuestionModal applicationId={id} questions={open} onDone={refresh} />}

      {detail.status === 'REVIEW' && <ReviewPanel applicationId={id} detail={detail} onDone={refresh} />}

      {detail.fieldPlan && detail.status !== 'REVIEW' && <FieldPlan plan={detail.fieldPlan} />}

      {detail.coverLetter && (
        <div className="panel">
          <h2>Cover letter</h2>
          <p className="sub">Written for this role from your resume and the job description.</p>
          <textarea readOnly value={detail.coverLetter} style={{ minHeight: '12rem' }} />
        </div>
      )}

      <div className="panel">
        <h2>Run log</h2>
        <div className="log" ref={logRef}>
          {events.map((e, i) => (
            <div className="line" key={i}>
              <span className="t">{new Date(e.at).toLocaleTimeString()}</span>
              <span className={e.type}>{e.message}</span>
            </div>
          ))}
          {events.length === 0 && <span className="muted">waiting…</span>}
        </div>
      </div>

    </>
  );
}

/**
 * The popup. This is what happens when the system will not guess: it asks,
 * and (unless you say otherwise) it keeps the answer for every future
 * application.
 */
function QuestionModal({
  applicationId,
  questions,
  onDone,
}: {
  applicationId: string;
  questions: PendingQuestion[];
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string | string[]>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, initialValue(q)])),
  );
  const [remember, setRemember] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, initialRemember(q)])),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/applications/${applicationId}/answers`, {
        method: 'POST',
        body: JSON.stringify({
          answers: questions.map((q) => ({
            questionId: q.id,
            fieldId: q.fieldId,
            value: values[q.id] ?? '',
            remember: remember[q.id] ?? false,
          })),
        }),
      });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2 style={{ margin: '0 0 .2rem' }}>
          {questions.length} question{questions.length === 1 ? '' : 's'} for you
        </h2>
        <p className="sub">
          These could not be answered from your profile or resume, so nothing was guessed. Your
          answers are saved and reused automatically next time.
        </p>

        {questions.map((q) => (
          <QuestionField
            key={q.id}
            q={q}
            value={values[q.id]}
            remember={remember[q.id] ?? false}
            onValue={(v) => setValues((s) => ({ ...s, [q.id]: v }))}
            onRemember={(r) => setRemember((s) => ({ ...s, [q.id]: r }))}
          />
        ))}

        {err && <div className="notice bad" style={{ margin: '.8rem 0' }}>{err}</div>}
        <div className="row" style={{ marginTop: '1rem' }}>
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => onDone()}
            style={{ marginLeft: '.5rem' }}
          >
            Close
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * The run is stopped at something only a person can clear.
 *
 * A sign-in, an account, an emailed code, a captcha. The browser is still open
 * on that exact page and the wizard is still half-filled behind it — so the
 * useful thing here is not an error message but a button that says "done,
 * keep going".
 */
function WallPanel({
  applicationId,
  detail,
  onDone,
}: {
  applicationId: string;
  detail: { blockedReason: string | null };
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(carryOn: boolean) {
    setBusy(carryOn ? 'go' : 'stop');
    setError(null);
    try {
      await api(`/api/applications/${applicationId}/continue`, {
        method: 'POST',
        body: JSON.stringify({ carryOn }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="panel"
      style={{ borderColor: 'var(--warn-border)', background: 'var(--warn-soft)' }}
    >
      <h2>Waiting for you in the browser</h2>
      <p className="sub" style={{ maxWidth: '44rem' }}>
        {detail.blockedReason ?? 'Something on the page needs a person.'}
      </p>
      <p className="small muted" style={{ maxWidth: '44rem' }}>
        Deal with it in the browser window that is already open — do not close it. The application
        is filled in behind that page and picks up from exactly where it stopped. Signing in is
        remembered, so you should only have to do it once per site.
      </p>
      {error && <div className="notice bad">{error}</div>}
      <div className="row" style={{ gap: '.5rem', marginTop: '.6rem' }}>
        <button className="primary" disabled={busy !== null} onClick={() => send(true)}>
          {busy === 'go' ? 'Continuing…' : "Done — carry on"}
        </button>
        <button className="danger" disabled={busy !== null} onClick={() => send(false)}>
          Cancel this application
        </button>
      </div>
    </div>
  );
}

/**
 * The run is over and nobody could see whether the submit landed.
 *
 * "Carry on" means nothing here - there is no paused run to carry on. The
 * only useful thing is for you to look, and tell us which it was.
 */
function OutcomePanel({
  applicationId,
  detail,
  onDone,
}: {
  applicationId: string;
  detail: AppDetail;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function record(submitted: boolean) {
    setBusy(submitted ? 'yes' : 'no');
    setError(null);
    try {
      await api(`/api/applications/${applicationId}/outcome`, {
        method: 'POST',
        body: JSON.stringify({ submitted }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Older runs stored the whole page's text here; show only the first sentence.
  const reason = (detail.blockedReason ?? '').startsWith('Could not confirm')
    ? 'Submit was pressed but no confirmation appeared.'
    : detail.blockedReason;

  return (
    <div className="panel" style={{ borderColor: 'var(--warn-border)', background: 'var(--warn-soft)' }}>
      <h2>Did this application go through?</h2>
      <p className="sub" style={{ maxWidth: '44rem' }}>
        {reason ?? 'We could not tell whether the submit worked.'}
      </p>
      <p className="small muted" style={{ maxWidth: '44rem' }}>
        Look at the browser window, or check your email for a confirmation from{' '}
        {detail.job.company}. Then tell us which it was.{' '}
        <a href={detail.job.url} target="_blank" rel="noreferrer">Open the job page</a>
      </p>
      {error && <div className="notice bad">{error}</div>}
      <div className="row" style={{ gap: '.5rem', marginTop: '.6rem' }}>
        <button className="primary" disabled={busy !== null} onClick={() => record(true)}>
          {busy === 'yes' ? 'Saving…' : 'Yes, it was submitted'}
        </button>
        <button className="ghost" disabled={busy !== null} onClick={() => record(false)}>
          {busy === 'no' ? 'Saving…' : 'No, it didn’t go through'}
        </button>
      </div>
    </div>
  );
}

/** First sentence of a long diagnosis, with the rest behind a disclosure. */
function Reason({ text }: { text: string | null }) {
  if (!text) return null;
  const first = /^.{20,220}?[.!?](\s|$)/.exec(text)?.[0]?.trim() ?? text.slice(0, 220);
  const rest = text.slice(first.length).trim();
  return (
    <>
      <p className="sub" style={{ maxWidth: '44rem' }}>{first}</p>
      {rest && (
        <details className="small muted" style={{ maxWidth: '44rem', marginBottom: '.6rem' }}>
          <summary>Details</summary>
          <p style={{ wordBreak: 'break-word' }}>{rest}</p>
        </details>
      )}
    </>
  );
}

/**
 * The run gave up before submitting and is no longer waiting on anything.
 * Nothing was sent, so the only questions are: try again, or look yourself.
 */
function StoppedPanel({
  applicationId,
  detail,
  onDone,
}: {
  applicationId: string;
  detail: AppDetail;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/applications/${applicationId}/start`, { method: 'POST' });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ borderColor: 'var(--warn-border)', background: 'var(--warn-soft)' }}>
      <h2>This application stopped before submitting</h2>
      <Reason text={detail.blockedReason?.replace(/^UNKNOWN:\s*/, '') ?? null} />
      <p className="small muted" style={{ maxWidth: '44rem' }}>
        Nothing was sent to {detail.job.company}.{' '}
        <a href={detail.job.url} target="_blank" rel="noreferrer">Open the job page</a>
      </p>
      {error && <div className="notice bad">{error}</div>}
      <div className="row" style={{ gap: '.5rem', marginTop: '.6rem' }}>
        <button className="primary" disabled={busy} onClick={retry}>
          {busy ? 'Starting…' : 'Try again'}
        </button>
      </div>
    </div>
  );
}

function ReviewPanel({
  applicationId,
  detail,
  onDone,
}: {
  applicationId: string;
  detail: AppDetail;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function decide(approved: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/applications/${applicationId}/review`, {
        method: 'POST',
        body: JSON.stringify({ approved }),
      });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="panel"
      style={{ borderColor: 'var(--warn-border)', background: 'var(--warn-soft)' }}
    >
      <h2>Ready to submit</h2>
      <p className="sub">
        The form is filled and open in the browser. Check the values, deal with any captcha there,
        then approve.
      </p>
      {detail.fieldPlan && <FieldPlan plan={detail.fieldPlan} bare />}
      {err && <div className="notice bad" style={{ margin: '.8rem 0' }}>{err}</div>}
      <div className="row" style={{ marginTop: '1rem' }}>
        <button className="primary" disabled={busy} onClick={() => decide(true)}>Submit application</button>
        <button className="danger" disabled={busy} onClick={() => decide(false)}>Cancel</button>
      </div>
    </div>
  );
}

function FieldPlan({ plan, bare = false }: { plan: PlanRow[]; bare?: boolean }) {
  const body = (
    <table>
      <thead>
        <tr><th>Field</th><th>Value</th><th>Where it came from</th></tr>
      </thead>
      <tbody>
        {plan.map((p, i) => (
          <tr key={i}>
            <td>{p.label}</td>
            <td style={{ maxWidth: '22rem' }}>
              {p.value === null || p.value === ''
                ? <span className="muted">— left blank</span>
                : Array.isArray(p.value) ? p.value.join(', ') : String(p.value)}
              {p.error && <div className="small" style={{ color: 'var(--bad)' }}>{p.error}</div>}
            </td>
            <td>
              <span className={`src ${p.source}`}>{p.source.replace('_', ' ')}</span>
              {p.rationale && <div className="muted small">{p.rationale}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  if (bare) return body;
  return (
    <div className="panel">
      <h2>What was filled in</h2>
      <p className="sub">Every value, and where it came from. This is the audit trail.</p>
      {body}
    </div>
  );
}
