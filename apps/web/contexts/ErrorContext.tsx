'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

interface ErrorContextType {
  rateLimitError: { provider: 'anthropic' | 'gemini' | null; message: string } | null;
  showRateLimitModal: (provider: 'anthropic' | 'gemini' | null, message: string) => void;
  hideRateLimitModal: () => void;
}

const ErrorContext = createContext<ErrorContextType | undefined>(undefined);

export function ErrorProvider({ children }: { children: ReactNode }) {
  const [rateLimitError, setRateLimitError] = useState<{ provider: 'anthropic' | 'gemini' | null; message: string } | null>(null);

  const showRateLimitModal = (provider: 'anthropic' | 'gemini' | null, message: string) => {
    setRateLimitError({ provider, message });
  };

  const hideRateLimitModal = () => {
    setRateLimitError(null);
  };

  return (
    <ErrorContext.Provider value={{ rateLimitError, showRateLimitModal, hideRateLimitModal }}>
      {children}
    </ErrorContext.Provider>
  );
}

export function useError() {
  const context = useContext(ErrorContext);
  if (context === undefined) {
    throw new Error('useError must be used within an ErrorProvider');
  }
  return context;
}
