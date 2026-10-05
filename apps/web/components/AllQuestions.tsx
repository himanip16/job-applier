'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  QuestionField,
  initialRemember,
  initialValue,
  isAnswered,
  type AnswerValue,
  type PendingQuestion,
} from './QuestionField';

interface Group {
  applicationId: string;
  /** Still waiting on these answers; otherwise the run has ended and answering puts it back in the queue. */
  live: boolean;
  title: string;
  company: string;
  questions: PendingQuestion[];
}

/**
 * Every open question, from every run, in one place.
 *
 * Runs ask independently, and auto-apply sets each one aside and moves on, so
 * questions pile up across jobs. Answering them one run page at a time is the
 * babysitting this is meant to remove: here they are grouped under their job,
 * and one press sends every job whose required questions are answered. Jobs
 * left incomplete stay in the list for later.
 *
 * A run parked on its questions carries on once answered. One that has
 * already ended - set aside by auto-apply, or its tab closed - goes back in
 * the queue with the answers, and remembered ones go to the answer bank
 * either way.
 */
export function AllQuestions({
  onClose,
  auto = false,
}: {
  onClose: () => void;
  /** Opened by itself rather than by you: an empty list then closes instead of showing nothing. */
  auto?: boolean;
}) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [values, setValues] = useState<Record<string, AnswerValue>>({});
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /** Returns how many jobs still have questions. */
  async function load(): Promise<number> {
    const { applications } = await api<{
      applications: { id: string; status: string; _count: { pending: number } }[];
    }>('/api/applications');
    // Not SUBMITTED or CANCELLED: questions there are history, not something to answer.
    const waiting = applications.filter((a) => a._count.pending > 0 && !['SUBMITTED', 'CANCELLED'].includes(a.status));
    const details = await Promise.all(
      waiting.map((a) =>
        api<{ application: { id: string; status: string; job: { title: string; company: string }; pending: PendingQuestion[] } }>(
          `/api/applications/${a.id}`,
        ).catch(() => null),
      ),
    );
    const next = details.flatMap((d) => {
      const open = d?.application.pending.filter((q) => !q.answeredAt) ?? [];
      return d && open.length
        ? [{
            applicationId: d.application.id,
            live: d.application.status === 'NEEDS_INPUT',
            title: d.application.job.title,
            company: d.application.job.company,
            questions: open,
          }]
        : [];
    });
    // Keep whatever was already typed; only fill in questions seen for the first time.
    const all = next.flatMap((g) => g.questions);
    setValues((v) => ({ ...Object.fromEntries(all.map((q) => [q.id, initialValue(q)])), ...v }));
    setRemember((r) => ({ ...Object.fromEntries(all.map((q) => [q.id, initialRemember(q)])), ...r }));
    setGroups(next);
    return next.length;
  }

  useEffect(() => {
    load()
      .then((n) => {
        // The questions that triggered it were answered elsewhere, or belong to
        // a run this account cannot open. An empty popup is just noise.
        if (auto && n === 0) onClose();
      })
      .catch((e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const complete = (g: Group) => g.questions.every((q) => !q.required || isAnswered(values[q.id]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!groups) return;
    const ready = groups.filter(complete);
    if (!ready.length) {
      setErr('Answer every required (*) question for at least one job first.');
      return;
    }
    setBusy(true);
    setErr(null);
    setNote(null);
    const failed: string[] = [];
    let requeued = 0;
    await Promise.all(
      ready.map((g) =>
        api<{ resumed?: 'elsewhere' | 'restarted' | 'waiting' }>(`/api/applications/${g.applicationId}/answers`, {
          method: 'POST',
          body: JSON.stringify({
            answers: g.questions.map((q) => ({
              questionId: q.id,
              fieldId: q.fieldId,
              value: values[q.id] ?? '',
              remember: remember[q.id] ?? false,
            })),
          }),
        })
          .then((r) => { if (r.resumed === 'restarted') requeued++; })
          .catch(() => failed.push(`${g.title} — ${g.company}`)),
      ),
    );
    const sentOk = ready.filter((g) => !failed.includes(`${g.title} — ${g.company}`));
    const resumed = sentOk.length - requeued;
    const left = groups.length - ready.length;
    setNote(
      [
        resumed && `${resumed} job${resumed === 1 ? '' : 's'} carrying on with your answers.`,
        requeued && `${requeued} ended run${requeued === 1 ? '' : 's'} back in the queue with your answers.`,
        left && `${left} still need${left === 1 ? 's' : ''} answers.`,
      ].filter(Boolean).join(' '),
    );
    if (failed.length) setErr(`Could not send: ${failed.join(', ')}.`);
    const remaining = await load().catch(() => -1);
    setBusy(false);
    // Everything answered: show what happened for a moment, then get out of the way.
    if (remaining === 0 && !failed.length) setTimeout(onClose, 2500);
  }

  const total = groups?.reduce((n, g) => n + g.questions.length, 0) ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onSubmit={submit} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 style={{ margin: '0 0 .2rem' }}>
          {groups === null
            ? 'Loading questions…'
            : total
              ? `${total} question${total === 1 ? '' : 's'} across ${groups.length} job${groups.length === 1 ? '' : 's'}`
              : note
                ? 'All answered'
                : 'No questions waiting'}
        </h2>
        {total > 0 && <p className="sub">
          These could not be answered from your profile or resume, so nothing was guessed. Answer what you
          can: every job with its required (*) questions answered is sent on, and the rest wait here.
        </p>}

        {note && <div className="notice good" style={{ margin: '.6rem 0' }}>{note}</div>}

        {groups?.map((g) => (
          <section
            key={g.applicationId}
            style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '.2rem .9rem', margin: '.8rem 0' }}
          >
            <div className="spread" style={{ padding: '.6rem 0 .2rem', gap: '.6rem' }}>
              <strong style={{ minWidth: 0 }}>
                {g.title} <span className="muted">— {g.company}</span>
              </strong>
              <span className="row small" style={{ gap: '.6rem', flex: 'none' }}>
                {!g.live && <span className="muted" title="This run has ended. Answering puts it back in the queue.">run ended</span>}
                {complete(g) ? (
                  <span style={{ color: 'var(--good)' }}>ready</span>
                ) : (
                  <span className="muted">
                    {g.questions.filter((q) => q.required && !isAnswered(values[q.id])).length} required left
                  </span>
                )}
                <a href={`/applications/${g.applicationId}`} className="muted">open run</a>
              </span>
            </div>
            {g.questions.map((q) => (
              <QuestionField
                key={q.id}
                q={q}
                value={values[q.id]}
                remember={remember[q.id] ?? false}
                onValue={(v) => setValues((s) => ({ ...s, [q.id]: v }))}
                onRemember={(r) => setRemember((s) => ({ ...s, [q.id]: r }))}
              />
            ))}
          </section>
        ))}

        {err && <div className="notice bad" style={{ margin: '.8rem 0' }}>{err}</div>}
        <div className="row" style={{ marginTop: '1rem' }}>
          {total > 0 && (
            <button className="primary" disabled={busy}>
              {busy
                ? 'Sending…'
                : `Send answers for ${groups!.filter(complete).length} ready job${groups!.filter(complete).length === 1 ? '' : 's'}`}
            </button>
          )}
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            {total ? 'Later' : 'Close'}
          </button>
        </div>
      </form>
    </div>
  );
}
