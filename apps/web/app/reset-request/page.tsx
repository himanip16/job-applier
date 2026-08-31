'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';

/**
 * Request a password reset.
 *
 * Users enter their email address and receive a reset link.
 * For security, this always returns success even if the email doesn't exist.
 */
export default function ResetRequestPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDevToken(null);
    try {
      const response = await api<{ ok: boolean; token?: string; message?: string }>('/api/auth/reset-request', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setSuccess(true);
      // In development mode, the token is returned for testing
      if (response.token) {
        setDevToken(response.token);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
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
            <h2>Check your email</h2>
            <p className="sub">
              If an account exists for {email}, you'll receive a password reset link shortly.
            </p>

            {devToken && (
              <div className="notice" style={{ marginTop: '1rem', textAlign: 'left' }}>
                <strong>Development mode:</strong>
                <p style={{ margin: '.5rem 0', wordBreak: 'break-all' }}>
                  Token: <code>{devToken}</code>
                </p>
                <button
                  className="ghost"
                  onClick={() => router.push(`/reset-complete?token=${devToken}`)}
                  style={{ padding: '.3rem .6rem' }}
                >
                  Use this token
                </button>
              </div>
            )}

            <button
              className="primary"
              onClick={() => router.push('/signin')}
              style={{ marginTop: '1.5rem', width: '100%' }}
            >
              Back to sign in
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
          <h2>Reset your password</h2>
          <p className="sub">Enter your email address and we'll send you a reset link.</p>

          <form onSubmit={submit}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                required
                autoFocus
                autoComplete="email"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            {error && <div className="notice bad" style={{ marginBottom: '.9rem' }}>{error}</div>}

            <button className="primary" disabled={busy} style={{ width: '100%' }}>
              {busy && <span className="spinner" style={{ marginRight: '.5rem' }} />}
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        </div>

        <p className="muted small" style={{ marginTop: '1.1rem', textAlign: 'center' }}>
          Remember your password?{' '}
          <button
            className="ghost"
            style={{ padding: '.1rem .4rem', color: 'var(--accent)' }}
            onClick={() => router.push('/signin')}
          >
            Sign in
          </button>
        </p>
      </div>
    </div>
  );
}
