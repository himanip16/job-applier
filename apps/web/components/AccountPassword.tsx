'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Waiting {
  id: string;
  status: string;
  title: string;
  company: string;
  reason: string | null;
}

/**
 * A job site's own "Create Account / Sign In" with no password saved yet.
 *
 * The run fills those with your profile email and the saved job site password.
 * Without one it would just sit there, so this asks - once saved, the waiting
 * run signs in by itself, and so does every later account wall.
 *
 * Not for Google / Microsoft / Okta hand-offs: a password here does not help
 * with those, and the run says "handed off to <host>" for them.
 */
export function AccountPassword({ waiting }: { waiting: Waiting | null }) {
  const wall =
    waiting?.status === 'NEEDS_HUMAN' &&
    /^(LOGIN_REQUIRED|ACCOUNT_CREATION):/.test(waiting.reason ?? '') &&
    !/handed off to/i.test(waiting.reason ?? '') &&
    // Google / Microsoft buttons only: SsoProvider asks for those instead.
    !/only offers sign-in through/i.test(waiting.reason ?? '');

  const [saved, setSaved] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!wall) return;
    let cancelled = false;
    api<{ settings: Array<{ key: string; set: boolean }> }>('/api/settings')
      .then((r) => {
        if (!cancelled) setSaved(Boolean(r.settings.find((x) => x.key === 'JOB_SITE_PASSWORD')?.set));
      })
      .catch(() => {
        // Unknown: better silent than a popup asking for something already saved.
        if (!cancelled) setSaved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [wall, waiting?.id]);

  if (!wall || saved !== false || dismissed === waiting!.id) return null;

  const problem =
    value.length < 8
      ? 'At least 8 characters.'
      : !/[a-z]/.test(value) || !/[A-Z]/.test(value)
        ? 'Include upper and lower case letters.'
        : !/\d/.test(value)
          ? 'Include a number.'
          : !/[^A-Za-z0-9]/.test(value)
            ? 'Include a special character.'
            : value !== confirmValue
              ? 'The two passwords do not match.'
              : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (problem) return setErr(problem);
    setBusy(true);
    setErr(null);
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: 'JOB_SITE_PASSWORD', value, verify: false }),
      });
      setValue('');
      setConfirmValue('');
      setSaved(true);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setDismissed(waiting!.id)}>
      <form className="modal" onSubmit={save} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 style={{ margin: '0 0 .2rem' }}>Password for job site accounts</h2>
        <p className="sub">
          {waiting!.title} — {waiting!.company} wants you to create an account or sign in. Choose a
          password and the run fills it in with your profile email and carries on. It is saved and
          used for every later job site account too. You can change it in Settings.
        </p>
        <label style={{ display: 'block', marginTop: '.8rem' }}>
          Password
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="new-password"
            autoFocus
            spellCheck={false}
          />
        </label>
        <label style={{ display: 'block', marginTop: '.6rem' }}>
          Type it again
          <input
            type="password"
            value={confirmValue}
            onChange={(e) => setConfirmValue(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
          />
        </label>
        <p className="muted small" style={{ marginTop: '.5rem' }}>
          Most sites want 8+ characters with upper and lower case, a number and a symbol.
        </p>
        {err && <div className="notice bad" style={{ margin: '.8rem 0' }}>{err}</div>}
        <div className="row" style={{ marginTop: '1rem' }}>
          <button className="primary" disabled={busy || !value || !confirmValue}>
            {busy ? 'Saving…' : 'Save and sign in'}
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => setDismissed(waiting!.id)}>
            I will do it in the browser
          </button>
        </div>
      </form>
    </div>
  );
}
