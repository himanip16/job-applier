'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

export interface AuthState {
  loading: boolean;
  authenticated: boolean;
  user: { id: string; email: string } | null;
  profile: { id: string; fullName: string } | null;
  hasAccounts: boolean;
  error: string | null;
}

/**
 * Shared authentication state hook.
 *
 * This provides a single source of truth for authentication status across
 * the application, allowing components to distinguish between:
 * - Loading auth state
 * - Authenticated with profile
 * - Authenticated without profile
 * - Not authenticated
 * - Auth API errors
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    authenticated: false,
    user: null,
    profile: null,
    hasAccounts: false,
    error: null,
  });

  useEffect(() => {
    let live = true;

    api<{
      user: { id: string; email: string } | null;
      profile: { id: string; fullName: string } | null;
      hasAccounts: boolean;
    }>('/api/auth/me')
      .then((d) => {
        if (!live) return;
        setState({
          loading: false,
          authenticated: !!d.user,
          user: d.user,
          profile: d.profile ?? null,
          hasAccounts: d.hasAccounts,
          error: null,
        });
      })
      .catch((err) => {
        if (!live) return;
        setState({
          loading: false,
          authenticated: false,
          user: null,
          profile: null,
          hasAccounts: false,
          error: err.message || 'Failed to check authentication',
        });
      });

    return () => {
      live = false;
    };
  }, []);

  return state;
}