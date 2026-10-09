'use client';

import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface NamedKey {
  id: string;
  name: string;
  value: string;
}

interface NamedKeySet {
  activeId?: string;
  keys: NamedKey[];
}

interface RateLimitModalProps {
  isOpen: boolean;
  onClose: () => void;
  provider: 'anthropic' | 'gemini' | null;
}

export function RateLimitModal({ isOpen, onClose, provider }: RateLimitModalProps) {
  const [namedKeys, setNamedKeys] = useState<{ anthropic: NamedKeySet; gemini: NamedKeySet }>({
    anthropic: { keys: [] },
    gemini: { keys: [] },
  });
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'switch' | 'add'>('switch');

  useEffect(() => {
    if (isOpen) {
      loadKeys();
    }
  }, [isOpen]);

  const loadKeys = async () => {
    try {
      const data = await api<{ namedKeys: { anthropic: NamedKeySet; gemini: NamedKeySet } }>('/api/settings');
      setNamedKeys(data.namedKeys);
    } catch (err) {
      console.error('Failed to load keys:', err);
    }
  };

  const handleSetActive = async (id: string, prov: 'anthropic' | 'gemini') => {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/settings/keys/${prov}/active`, {
        method: 'PUT',
        body: JSON.stringify({ id }),
      });
      await loadKeys();
      setMessage('Key switched successfully');
      setTimeout(() => onClose(), 1000);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleAddKey = async () => {
    if (!newKeyName.trim() || !newKeyValue.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const targetProvider = provider || 'gemini';
      await api(`/api/settings/keys/${targetProvider}`, {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName, value: newKeyValue }),
      });
      setNewKeyName('');
      setNewKeyValue('');
      await loadKeys();
      setMessage('Key added successfully');
      setTimeout(() => onClose(), 1000);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  const relevantProvider = provider || 'gemini';
  const keys = namedKeys[relevantProvider].keys;
  const activeId = namedKeys[relevantProvider].activeId;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 .2rem' }}>Rate limit reached</h2>
        <p className="muted" style={{ marginBottom: '1rem' }}>
          {provider ? `${provider.charAt(0).toUpperCase() + provider.slice(1)} rate limit exceeded. ` : 'Rate limit exceeded. '}
          You can switch to another saved key or add a new one.
        </p>

        <div className="row" style={{ gap: '.5rem', marginBottom: '1rem' }}>
          <button
            className={activeTab === 'switch' ? 'primary' : ''}
            onClick={() => setActiveTab('switch')}
            disabled={busy}
          >
            Switch to existing key
          </button>
          <button
            className={activeTab === 'add' ? 'primary' : ''}
            onClick={() => setActiveTab('add')}
            disabled={busy}
          >
            Add new key
          </button>
        </div>

        {activeTab === 'switch' && (
          <div>
            {keys.length === 0 ? (
              <p className="muted">No saved keys available. Add a new key instead.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
                {keys.map((key) => (
                  <div
                    key={key.id}
                    className="row"
                    style={{
                      padding: '.75rem',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <strong>{key.name}</strong>
                      {key.id === activeId && (
                        <span className="pill" style={{ marginLeft: '.5rem', fontSize: '0.75rem' }}>
                          Active
                        </span>
                      )}
                    </div>
                    {key.id !== activeId && (
                      <button
                        onClick={() => handleSetActive(key.id, relevantProvider)}
                        disabled={busy}
                        style={{ padding: '.4rem .8rem' }}
                      >
                        Switch
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'add' && (
          <div>
            <div style={{ marginBottom: '.5rem' }}>
              <label className="small muted">Key name</label>
              <input
                type="text"
                placeholder="e.g., Personal Anthropic Key"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                disabled={busy}
                style={{ width: '100%', marginTop: '.25rem' }}
              />
            </div>
            <div style={{ marginBottom: '.5rem' }}>
              <label className="small muted">API key</label>
              <input
                type="password"
                placeholder="Paste your API key"
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
                disabled={busy}
                style={{ width: '100%', marginTop: '.25rem' }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button
              className="primary"
              onClick={handleAddKey}
              disabled={busy || !newKeyName.trim() || !newKeyValue.trim()}
            >
              {busy ? 'Adding…' : 'Add key'}
            </button>
          </div>
        )}

        {message && (
          <div className={`notice ${message.includes('success') || message.includes('switched') ? 'good' : 'bad'}`} style={{ marginTop: '1rem' }}>
            {message}
          </div>
        )}

        <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
