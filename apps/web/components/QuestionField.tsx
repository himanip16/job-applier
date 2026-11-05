'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/**
 * One question a run would not guess at, and the input to answer it.
 *
 * Shared by the run page's popup and the "answer everything" popup, so a
 * question reads the same - and is answered the same way - wherever it shows.
 */

export interface PendingQuestion {
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
  /** What you typed before, kept even when the job's answers were never sent. */
  answerValue?: AnswerValue | null;
}

export type AnswerValue = string | string[];

/** What the box starts with: the run's suggestion, if it had one. */
export const initialValue = (q: PendingQuestion): AnswerValue =>
  q.answerValue ?? q.suggestion ?? (isMulti(q) ? [] : '');

/** Policy questions (demographics and the like) are not remembered unless you say so. */
export const initialRemember = (q: PendingQuestion): boolean => q.reason !== 'POLICY';

export const isAnswered = (v: AnswerValue | undefined): boolean =>
  Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim() !== '';

export function QuestionField({
  q,
  value,
  remember,
  onValue,
  onRemember,
}: {
  q: PendingQuestion;
  value: AnswerValue | undefined;
  remember: boolean;
  onValue: (v: AnswerValue) => void;
  onRemember: (r: boolean) => void;
}) {
  const saved = useDraftSave(q, value, remember);
  return (
    <div className="q">
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

      {renderInput(q, value, onValue)}

      <label className="row small" style={{ marginTop: '.45rem' }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={remember}
          onChange={(e) => onRemember(e.target.checked)}
        />
        <span className="muted">Remember this answer for future applications</span>
        {saved && <span className="muted" style={{ marginLeft: 'auto' }}>{saved}</span>}
      </label>
    </div>
  );
}

/**
 * Saves each answer to your answer bank as you give it, not only when the
 * job's answers are sent. A job you never finish answering, or never apply
 * to, would otherwise lose everything you typed for it. Only what you change
 * is saved: an untouched suggestion is still the run's guess, not your answer.
 */
function useDraftSave(q: PendingQuestion, value: AnswerValue | undefined, remember: boolean): string | null {
  const [status, setStatus] = useState<string | null>(null);
  const key = JSON.stringify([value, remember]);
  // What the box opened with; leaving it as it was is not an answer.
  const opened = useRef(key);
  useEffect(() => {
    if (key === opened.current || value === undefined) return;
    const t = setTimeout(() => {
      setStatus('Saving…');
      api<{ saved: boolean }>(`/api/questions/${q.id}/draft`, {
        method: 'POST',
        body: JSON.stringify({ value, remember }),
      })
        .then((r) => setStatus(r.saved ? 'Saved to your answers' : null))
        .catch(() => setStatus('Not saved yet'));
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return status;
}

function isMulti(q: PendingQuestion) {
  return q.fieldKind === 'MULTISELECT' || q.fieldKind === 'CHECKBOX_GROUP';
}

function renderInput(
  q: PendingQuestion,
  value: AnswerValue | undefined,
  onChange: (v: AnswerValue) => void,
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
  // A lone checkbox is a yes/no, usually consent. The filler ticks it for
  // "yes"; asking you to type that into a text box was the old behaviour.
  if (q.fieldKind === 'CHECKBOX') {
    return (
      <label className="row small" style={{ gap: '.5rem', marginTop: '.3rem' }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={value === 'yes'}
          onChange={(e) => onChange(e.target.checked ? 'yes' : 'no')}
        />
        <span>Tick the box</span>
      </label>
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
