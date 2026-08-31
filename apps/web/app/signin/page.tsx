'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '../../lib/api';

/**
 * Sign in, or make the first account.
 *
 * One page for both, because the answer to "do I have an account here?" is
 * usually obvious to the person and never worth a second page. Which mode it
 * opens in is decided by whether the server has any accounts at all: on a
 * fresh install the honest first screen is "create your account".
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';

  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [decided, setDecided] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api<{ user: { email: string } | null; hasAccounts: boolean }>('/api/auth/me')
      .then((d) => {
        if (d.user) {
          router.replace(next);
          return;
        }
        if (!d.hasAccounts) {
          setMode('register');
          setNote(
            'No account exists yet. Create one — everything already set up on this ' +
              'machine will be attached to it.',
          );
        }
        setDecided(true);
      })
      .catch(() => setDecided(true));
    // Only on mount: re-running this on every `next` change would fight the redirect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/auth/${mode === 'register' ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      // A hard navigation, not router.push: every panel on the destination
      // reads from the API on mount, and they should all start from a request
      // that carries the new cookie.
      window.location.href = next;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!decided) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
        <span className="spinner" style={{ width: '1.4em', height: '1.4em' }} />
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '78vh', padding: '2rem 0' }}>
      <div style={{ width: 'min(26rem, 100%)' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.4rem' }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '2.75rem',
              height: '2.75rem',
              borderRadius: 'var(--radius)',
              background: 'linear-gradient(155deg, var(--accent), var(--accent-active))',
              color: '#fff',
              boxShadow: 'var(--shadow-md)',
              marginBottom: '.8rem',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 3 5 13.5h6L11 21l8-10.5h-6z" />
            </svg>
          </span>
          <h1 style={{ fontSize: '1.3rem', margin: 0 }}>Job Applier</h1>
        </div>

        <div className="panel" style={{ margin: 0 }}>
          <h2>{mode === 'register' ? 'Create your account' : 'Sign in'}</h2>
          <p className="sub">
            {mode === 'register'
              ? 'Your resume, your answers and every application stay attached to this account.'
              : 'Welcome back.'}
          </p>

          {note && <div className="notice" style={{ marginBottom: '.9rem' }}>{note}</div>}

          <form onSubmit={submit}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                required
                autoFocus
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                required
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {mode === 'signin' && (
              <p style={{ margin: '-.4rem 0 .9rem', textAlign: 'right' }}>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => router.push('/reset-request')}
                  style={{ padding: '.1rem .4rem', fontSize: '.85rem', color: 'var(--accent)' }}
                >
                  Forgot password?
                </button>
              </p>
            )}
            {mode === 'register' && (
              <p className="muted small" style={{ margin: '-.4rem 0 .9rem' }}>
                At least 10 characters. A short phrase you will remember beats a short password
                you will not.
              </p>
            )}

            {error && <div className="notice bad" style={{ marginBottom: '.9rem' }}>{error}</div>}

            <button className="primary" disabled={busy} style={{ width: '100%' }}>
              {busy && <span className="spinner" style={{ marginRight: '.5rem' }} />}
              {busy ? 'Working…' : mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="muted small" style={{ marginTop: '1.1rem', textAlign: 'center' }}>
          {mode === 'register' ? 'Already have an account? ' : 'No account yet? '}
          <button
            className="ghost"
            style={{ padding: '.1rem .4rem', color: 'var(--accent)' }}
            onClick={() => {
              setMode(mode === 'register' ? 'signin' : 'register');
              setError(null);
            }}
          >
            {mode === 'register' ? 'Sign in' : 'Create one'}
          </button>
        </p>
      </div>
    </div>
  );
}
