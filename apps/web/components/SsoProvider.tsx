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

const NAMES: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  apple: 'Apple',
};

/** Must match SSO_ONLY_PREFIX in apps/server/src/browser/blockers.ts. */
const SSO_ONLY = /^LOGIN_REQUIRED: This site only offers sign-in through ([a-z, ]+)\./;

/**
 * A sign-in wall with only "Sign in using Google / Microsoft / LinkedIn"
 * buttons (Microsoft Careers). Asks once which one to use and saves it; the
 * waiting run presses it by itself, and so does every later wall like it.
 */
export function SsoProvider({ waiting }: { waiting: Waiting | null }) {
  const match = waiting?.status === 'NEEDS_HUMAN' ? SSO_ONLY.exec(waiting.reason ?? '') : null;
  const offered = match ? (match[1] ?? '').split(',').map((p) => p.trim()).filter((p) => p in NAMES) : [];

  const [saved, setSaved] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!match) return;
    let cancelled = false;
    api<{ settings: Array<{ key: string; set: boolean }> }>('/api/settings')
      .then((r) => {
        if (!cancelled) setSaved(Boolean(r.settings.find((x) => x.key === 'SSO_PROVIDER')?.set));
      })
      .catch(() => {
        // Unknown: better silent than asking for something already saved.
        if (!cancelled) setSaved(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(match), waiting?.id]);

  if (!match || !offered.length || saved !== false || dismissed === waiting!.id) return null;

  async function choose(provider: string) {
    setBusy(true);
    setErr(null);
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: 'SSO_PROVIDER', value: provider, verify: false }),
      });
      setSaved(true);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setDismissed(waiting!.id)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 style={{ margin: '0 0 .2rem' }}>Which sign-in should the run use?</h2>
        <p className="sub">
          {waiting!.title} — {waiting!.company} only lets you sign in with another account. Pick one
          and the run presses that button now and on every later site like this. If that provider
          asks for your password, sign in once in the open browser window; it is remembered after
          that. You can change this in Settings.
        </p>
        <div className="row" style={{ marginTop: '1rem', flexWrap: 'wrap' }}>
          {offered.map((p) => (
            <button key={p} className="primary" disabled={busy} onClick={() => choose(p)}>
              Sign in using {NAMES[p]}
            </button>
          ))}
        </div>
        {err && <div className="notice bad" style={{ margin: '.8rem 0' }}>{err}</div>}
        <div className="row" style={{ marginTop: '.8rem' }}>
          <button type="button" className="ghost" disabled={busy} onClick={() => setDismissed(waiting!.id)}>
            I will do it in the browser
          </button>
        </div>
      </div>
    </div>
  );
}
