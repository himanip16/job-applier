'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '../../lib/api';

/**
 * Complete a password reset using a token from the email link.
 */
export default function ResetCompletePage() {
  return (
    <Suspense fallback={null}>
      <ResetCompleteForm />
    </Suspense>
  );
}

function ResetCompleteForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Redirect if no token provided
  useEffect(() => {
    if (!token) {
      router.replace('/reset-request');
    }
  }, [token, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      setBusy(false);
      return;
    }

    if (password.length < 10) {
      setError('Use at least 10 characters. A short phrase is ideal.');
      setBusy(false);
      return;
    }

    try {
      await api('/api/auth/reset-complete', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setSuccess(true);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!token) {
    return null;
  }

  if (success) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '78vh', padding: '2rem 0' }}>
        <div style={{ width: 'min(26rem, 100%)' }}>
          <div className="panel" style={{ margin: 0, textAlign: 'center' }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '3rem',
                height: '3rem',
                borderRadius: '50%',
                background: 'var(--success-bg)',
                color: 'var(--success)',
                marginBottom: '1rem',
              }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <h2>Password reset</h2>
            <p className="sub">Your password has been successfully reset.</p>

            <button
              className="primary"
              onClick={() => router.push('/signin')}
              style={{ marginTop: '1.5rem', width: '100%' }}
            >
              Sign in with new password
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '78vh', padding: '2rem 0' }}>
      <div style={{ width: 'min(26rem, 100%)' }}>
        <div className="panel" style={{ margin: 0 }}>
          <h2>Set new password</h2>
          <p className="sub">Enter your new password below.</p>

          <form onSubmit={submit}>
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                value={password}
                required
                autoFocus
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Confirm password</span>
              <input
                type="password"
                value={confirmPassword}
                required
                autoComplete="new-password"
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            <p className="muted small" style={{ margin: '-.4rem 0 .9rem' }}>
              At least 10 characters. A short phrase you will remember beats a short password you will not.
            </p>

            {error && <div className="notice bad" style={{ marginBottom: '.9rem' }}>{error}</div>}

            <button className="primary" disabled={busy} style={{ width: '100%' }}>
              {busy && <span className="spinner" style={{ marginRight: '.5rem' }} />}
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          </form>
        </div>

        <p className="muted small" style={{ marginTop: '1.1rem', textAlign: 'center' }}>
          <button
            className="ghost"
            style={{ padding: '.1rem .4rem', color: 'var(--accent)' }}
            onClick={() => router.push('/reset-request')}
          >
            Request new reset link
          </button>
        </p>
      </div>
    </div>
  );
}
