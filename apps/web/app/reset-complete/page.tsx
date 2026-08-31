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
  const [tokenError, setTokenError] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Password strength validation
  const passwordRequirements = {
    length: password.length >= 10,
    number: /\d/.test(password),
    special: /[!@#$%^&*(),.?":{}|<>]/.test(password),
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
  };

  const isPasswordValid = Object.values(passwordRequirements).every(Boolean);
  const passwordsMatch = password === confirmPassword && password.length > 0;

  // Show error if no token provided
  useEffect(() => {
    if (!token) {
      setTokenError(true);
    }
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api('/api/auth/reset-complete', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setSuccess(true);
    } catch (err) {
      const errorMessage = (err as Error).message;
      // Check if it's a token validation error
      if (errorMessage.includes('invalid') || errorMessage.includes('expired') || errorMessage.includes('token')) {
        setTokenError(true);
      } else {
        setError(errorMessage);
      }
      setBusy(false);
    }
  }

  if (tokenError || !token) {
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
                background: 'var(--error-bg)',
                color: 'var(--error)',
                marginBottom: '1rem',
              }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2>Invalid reset link</h2>
            <p className="sub">
              This reset link has expired or is invalid. Please request a new password reset link.
            </p>

            <div style={{ display: 'flex', gap: '.5rem', marginTop: '1.5rem' }}>
              <button
                className="primary"
                onClick={() => router.push('/reset-request')}
                style={{ flex: 1 }}
              >
                Request new link
              </button>
              <button
                className="ghost"
                onClick={() => router.push('/signin')}
                style={{ flex: 1 }}
              >
                Back to sign in
              </button>
            </div>
          </div>
        </div>
      </div>
    );
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
            <h2>Password reset successfully</h2>
            <p className="sub">
              Your password has been changed. You can now sign in with your new password.
            </p>

            <button
              className="primary"
              onClick={() => router.push('/signin')}
              style={{ marginTop: '1.5rem', width: '100%' }}
            >
              Sign in
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
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  required
                  autoFocus
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ paddingRight: '2.5rem' }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '0.5rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0.25rem',
                    color: 'var(--muted)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </label>
            <label className="field">
              <span>Confirm password</span>
              <div style={{ position: 'relative' }}>
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  required
                  autoComplete="new-password"
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  style={{ paddingRight: '2.5rem' }}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  style={{
                    position: 'absolute',
                    right: '0.5rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0.25rem',
                    color: 'var(--muted)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                >
                  {showConfirmPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </label>
            
            <div className="muted small" style={{ margin: '-.4rem 0 .9rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                  <span style={{ color: passwordRequirements.length ? 'var(--success)' : 'var(--muted)' }}>
                    {passwordRequirements.length ? '✓' : '○'}
                  </span>
                  <span>At least 10 characters</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                  <span style={{ color: passwordRequirements.uppercase ? 'var(--success)' : 'var(--muted)' }}>
                    {passwordRequirements.uppercase ? '✓' : '○'}
                  </span>
                  <span>Contains uppercase letter</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                  <span style={{ color: passwordRequirements.lowercase ? 'var(--success)' : 'var(--muted)' }}>
                    {passwordRequirements.lowercase ? '✓' : '○'}
                  </span>
                  <span>Contains lowercase letter</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                  <span style={{ color: passwordRequirements.number ? 'var(--success)' : 'var(--muted)' }}>
                    {passwordRequirements.number ? '✓' : '○'}
                  </span>
                  <span>Contains a number</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                  <span style={{ color: passwordRequirements.special ? 'var(--success)' : 'var(--muted)' }}>
                    {passwordRequirements.special ? '✓' : '○'}
                  </span>
                  <span>Contains a special character</span>
                </div>
                {confirmPassword.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                    <span style={{ color: password === confirmPassword ? 'var(--success)' : 'var(--error)' }}>
                      {password === confirmPassword ? '✓' : '○'}
                    </span>
                    <span>Passwords match</span>
                  </div>
                )}
              </div>
            </div>

            {error && <div className="notice bad" style={{ marginBottom: '.9rem' }}>{error}</div>}

            <button 
              className="primary" 
              disabled={busy || !isPasswordValid || !passwordsMatch} 
              style={{ width: '100%' }}
            >
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
          {' • '}
          <button
            className="ghost"
            style={{ padding: '.1rem .4rem', color: 'var(--accent)' }}
            onClick={() => router.push('/signin')}
          >
            Back to sign in
          </button>
        </p>
      </div>
    </div>
  );
}
