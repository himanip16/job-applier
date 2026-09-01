'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

let toastListeners: Set<(toasts: Toast[]) => void> = new Set();
let toasts: Toast[] = [];

export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const id = Math.random().toString(36).substring(2, 9);
  const toast: Toast = { id, message, type };
  toasts.push(toast);
  toastListeners.forEach(listener => listener([...toasts]));
  
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
    toastListeners.forEach(listener => listener([...toasts]));
  }, 3000);
}

function ToastRenderer() {
  const [currentToasts, setCurrentToasts] = useState<Toast[]>([]);

  useEffect(() => {
    toastListeners.add(setCurrentToasts);
    return () => {
      toastListeners.delete(setCurrentToasts);
    };
  }, []);

  return (
    <div style={{ 
      position: 'fixed', 
      bottom: '2rem', 
      right: '2rem', 
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      gap: '0.5rem',
    }}>
      {currentToasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            padding: '0.75rem 1rem',
            borderRadius: 'var(--radius)',
            background: toast.type === 'success' ? 'var(--good-soft)' : 
                       toast.type === 'error' ? 'var(--bad-soft)' : 'var(--accent-soft)',
            border: `1px solid ${toast.type === 'success' ? 'var(--good-border)' : 
                            toast.type === 'error' ? 'var(--bad-border)' : 'var(--accent-border)'}`,
            color: toast.type === 'success' ? 'var(--good)' : 
                   toast.type === 'error' ? 'var(--bad)' : 'var(--accent)',
            minWidth: '250px',
            maxWidth: '400px',
            boxShadow: 'var(--shadow-md)',
            animation: 'slideIn 0.2s var(--ease)',
          }}
        >
          {toast.message}
        </div>
      ))}
      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToastRenderer />
    </>
  );
}