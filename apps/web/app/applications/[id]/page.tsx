'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { API, api } from '../../../lib/api';
import { Loading } from '../../../components/Loading';

interface PendingQuestion {
  id: string;
  fieldId: string;
  rawLabel: string;
  helpText: string | null;
  fieldKind: string;
  options: { label: string; value?: string }[] | null;
  required: boolean;
  reason: 'NO_MATCH' | 'LOW_CONFIDENCE' | 'POLICY';
  suggestion: string | string[] | null;
  suggestionRationale: string | null;
  answeredAt: string | null;
}

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
  const [events, setEvents] = useState<Evt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(
    () => api<{ application: AppDetail }>(`/api/applications/${id}`)
      .then((d) => setDetail(d.application))
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
  const shots = detail.artifacts.filter((a) => a.kind === 'screenshot');

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
        {detail.blockedReason && (
          <div
            className={`notice ${detail.status === 'FAILED' ? 'bad' : detail.status === 'SUBMITTED' ? 'good' : ''}`}
            style={{ marginTop: '.9rem' }}
          >
            {detail.blockedReason}
          </div>
        )}
      </div>

      {detail.status === 'NEEDS_HUMAN' && <WallPanel applicationId={id} detail={detail} onDone={refresh} />}

      {open.length > 0 && <QuestionModal applicationId={id} questions={open} onDone={refresh} />}

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

      {shots.length > 0 && (
        <div className="panel">
          <h2>What the browser saw</h2>
          <p className="sub">Screenshots captured at each step — your record of what was submitted.</p>
          {shots.slice(-3).reverse().map((a) => (
            <figure key={a.id} style={{ margin: '0 0 1rem' }}>
              <img className="shot" src={`${API}/artifacts/${a.path}`} alt={a.label} />
              <figcaption className="muted small">{a.label}</figcaption>
            </figure>
          ))}
        </div>
      )}
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
    Object.fromEntries(questions.map((q) => [q.id, q.suggestion ?? (isMulti(q) ? [] : '')])),
  );
  const [remember, setRemember] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.reason !== 'POLICY'])),
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
          <div className="q" key={q.id}>
            <strong>{q.rawLabel}{q.required && <span style={{ color: 'var(--bad)' }}> *</span>}</strong>
            {q.helpText && <div className="why">{q.helpText}</div>}
            <div className={`why ${q.reason === 'POLICY' ? 'policy' : ''}`}>
              {q.reason === 'POLICY'
                ? 'Never answered automatically.'
                : q.reason === 'LOW_CONFIDENCE'
                  ? 'A guess was possible but not certain enough to submit under your name.'
                  : 'Not derivable from what we know about you.'}
              {q.suggestionRationale ? ` ${q.suggestionRationale}` : ''}
            </div>

            {renderInput(q, values[q.id], (v) => setValues((s) => ({ ...s, [q.id]: v })))}

            <label className="row small" style={{ marginTop: '.45rem' }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={remember[q.id] ?? false}
                onChange={(e) => setRemember((s) => ({ ...s, [q.id]: e.target.checked }))}
              />
              <span className="muted">Remember this answer for future applications</span>
            </label>
          </div>
        ))}

        {err && <div className="notice bad" style={{ margin: '.8rem 0' }}>{err}</div>}
        <div className="row" style={{ marginTop: '1rem' }}>
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
          <button 
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

function isMulti(q: PendingQuestion) {
  return q.fieldKind === 'MULTISELECT' || q.fieldKind === 'CHECKBOX_GROUP';
}

function renderInput(
  q: PendingQuestion,
  value: string | string[] | undefined,
  onChange: (v: string | string[]) => void,
) {
  if (q.options?.length) {
    if (isMulti(q)) {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <div>
          {q.options.map((o) => (
            <label className="row small" key={o.label}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={chosen.includes(o.label)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...chosen, o.label]
                      : chosen.filter((c) => c !== o.label),
                  )
                }
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }
    return (
      <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {q.options.map((o) => (
          <option key={o.label} value={o.label}>{o.label}</option>
        ))}
      </select>
    );
  }
  if (q.fieldKind === 'TEXTAREA') {
    return (
      <textarea
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
    />
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
