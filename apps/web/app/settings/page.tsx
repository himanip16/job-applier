'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';

/**
 * Keys, without a text editor.
 *
 * Every feature that needs a key used to fail by doing nothing, and the fix
 * was documented in a dotfile the person using the app never opens. So this
 * page does three things: takes the key, proves it works with a real call
 * before claiming it saved, and says plainly which features are now live.
 */

interface Setting {
  key: string;
  label: string;
  help: string;
  where: string;
  secret: boolean;
  origin: 'saved' | 'env' | 'unset';
  preview: string;
  set: boolean;
}

interface Effect {
  modelReady: boolean;
  searchReady: boolean;
  provider: string;
  writing: string;
  judgement: string;
}

interface NamedKey {
  id: string;
  name: string;
  value: string;
}

interface NamedKeySet {
  activeId?: string;
  keys: NamedKey[];
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [namedKeys, setNamedKeys] = useState<{ anthropic: NamedKeySet; gemini: NamedKeySet }>({
    anthropic: { keys: [] },
    gemini: { keys: [] },
  });
  const [effect, setEffect] = useState<Effect | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await api<{ settings: Setting[]; namedKeys: { anthropic: NamedKeySet; gemini: NamedKeySet }; effect: Effect }>('/api/settings');
    setSettings(d.settings);
    setNamedKeys(d.namedKeys);
    setEffect(d.effect);
  }, []);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  return (
    <>
      <div className="panel">
        <h2>Keys and settings</h2>
        <p className="sub">
          Saved in the app&apos;s own database and used immediately — no restart, no editing{' '}
          <code>.env</code>. Each one is checked against the real API before it is kept, so a key
          that does not work tells you here rather than failing quietly in the middle of a run.
        </p>
        {error && <div className="notice bad">{error}</div>}
        {effect && <WhatWorks effect={effect} />}
      </div>

      <div className="panel">
        {settings.map((s) => (
          <SettingRow key={s.key} setting={s} onChange={load} namedKeys={namedKeys} />
        ))}
      </div>

      <div className="panel">
        <NamedKeyManager provider="anthropic" state={namedKeys.anthropic} onChange={load} />
        <NamedKeyManager provider="gemini" state={namedKeys.gemini} onChange={load} />
      </div>

      <div className="panel">
        <h2>Where these are stored</h2>
        <p className="small muted" style={{ maxWidth: '46rem' }}>
          In the <code>settings</code> table of your Postgres database, in plain text. That is the
          same level of protection as the <code>.env</code> file it replaces — no better, and worth
          knowing. A saved key is never sent back to this page; you only ever see the first and
          last four characters. Anything still set in <code>.env</code> keeps working and is
          labelled as coming from there; clearing a saved key lets the <code>.env</code> value show
          through again.
        </p>
      </div>
    </>
  );
}

function WhatWorks({ effect }: { effect: Effect }) {
  return (
    <div className="row" style={{ gap: '1.5rem', marginTop: '.8rem', flexWrap: 'wrap' }}>
      <Live
        on={effect.modelReady}
        label="Cover letters, fit scoring, resume grounding"
        detail={effect.modelReady ? `${effect.provider} · ${effect.writing}` : 'Needs a model key'}
      />
      <Live
        on={effect.searchReady}
        label="Find jobs for me"
        detail={effect.searchReady ? 'Firecrawl connected' : 'Needs a Firecrawl key'}
      />
      <Live on label="Form filling, tracker, answer bank" detail="No key required" />
    </div>
  );
}

function Live({ on, label, detail }: { on: boolean; label: string; detail: string }) {
  return (
    <div>
      <div style={{ color: on ? 'var(--good)' : 'var(--muted)', fontWeight: 600 }}>
        {on ? '● live' : '○ off'}
      </div>
      <div className="small">{label}</div>
      <div className="muted small">{detail}</div>
    </div>
  );
}

function SettingRow({
  setting,
  onChange,
  namedKeys,
}: {
  setting: Setting;
  onChange: () => Promise<void>;
  namedKeys: { anthropic: NamedKeySet; gemini: NamedKeySet };
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  async function save(verify: boolean) {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ check: { ok: boolean; detail: string } | null }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: setting.key, value, verify }),
      });
      setValue('');
      setResult(r.check ?? { ok: true, detail: 'Saved without checking.' });
      await onChange();
    } catch (e) {
      setResult({ ok: false, detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setResult(null);
    try {
      await api(`/api/settings/${setting.key}`, { method: 'DELETE' });
      await onChange();
    } catch (e) {
      setResult({ ok: false, detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '.9rem 0' }}>
      <div className="spread">
        <div style={{ minWidth: 0 }}>
          <strong>{setting.label}</strong>{' '}
          <code className="small muted">{setting.key}</code>
          <div className="muted small" style={{ maxWidth: '40rem' }}>
            {setting.help}
            {setting.where && (
              <>
                {' '}
                Get one at{' '}
                <a href={`https://${setting.where}`} target="_blank" rel="noreferrer">
                  {setting.where}
                </a>
                .
              </>
            )}
          </div>
        </div>
        <Status setting={setting} />
      </div>

      {(['ANTHROPIC_API_KEY', 'GEMINI_API_KEY'] as const).includes(setting.key as never) && (
        <div style={{ marginTop: '.75rem' }}>
          <div className="muted small" style={{ marginBottom: '.35rem' }}>
            Saved keys for {setting.key === 'ANTHROPIC_API_KEY' ? 'Anthropic' : 'Gemini'}
          </div>
          <div className="small muted">
            Active:{' '}
            {(namedKeys[setting.key === 'ANTHROPIC_API_KEY' ? 'anthropic' : 'gemini'].keys.find(
              (k) => k.id === namedKeys[setting.key === 'ANTHROPIC_API_KEY' ? 'anthropic' : 'gemini'].activeId,
            ) ?? namedKeys[setting.key === 'ANTHROPIC_API_KEY' ? 'anthropic' : 'gemini'].keys[0])?.name ?? 'none'}
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: '.55rem', gap: '.5rem' }}>
        <input
          type={setting.secret ? 'password' : 'text'}
          placeholder={
            setting.key === 'LLM_PROVIDER'
              ? 'gemini, anthropic, or blank to auto-detect'
              : setting.set
                ? 'Paste a new key to replace it'
                : 'Paste your key'
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: 1, minWidth: '14rem' }}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="primary" disabled={busy || !value.trim()} onClick={() => save(true)}>
          {busy ? 'Checking…' : 'Save and check'}
        </button>
        {setting.secret && (
          <button
            disabled={busy || !value.trim()}
            onClick={() => save(false)}
            title="Save without calling the API. Use if you are offline, or to avoid the couple of credits a Firecrawl check costs."
          >
            Save only
          </button>
        )}
        {setting.origin === 'saved' && (
          <button disabled={busy} onClick={clear} title="Remove the saved value">
            Clear
          </button>
        )}
      </div>

      {result && (
        <div className={`notice ${result.ok ? 'good' : 'bad'}`} style={{ marginTop: '.5rem' }}>
          {result.detail}
        </div>
      )}
    </div>
  );
}

function NamedKeyManager({
  provider,
  state,
  onChange,
}: {
  provider: 'anthropic' | 'gemini';
  state: NamedKeySet;
  onChange: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    if (!name.trim() || !value.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/settings/keys/${provider}`, {
        method: 'POST',
        body: JSON.stringify({ name, value }),
      });
      setName('');
      setValue('');
      await onChange();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setActive(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/settings/keys/${provider}/active`, {
        method: 'PUT',
        body: JSON.stringify({ id }),
      });
      await onChange();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/settings/keys/${provider}/${id}`, { method: 'DELETE' });
      await onChange();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: '.8rem', marginTop: '.8rem' }}>
      <div className="spread" style={{ marginBottom: '.5rem' }}>
        <strong>{provider === 'anthropic' ? 'Anthropic' : 'Gemini'} keys</strong>
      </div>
      <div className="row" style={{ gap: '.5rem', marginBottom: '.5rem' }}>
        <input
          type="text"
          placeholder="Name this key"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minWidth: '10rem' }}
        />
        <input
          type="password"
          placeholder="Paste the API key"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: 2, minWidth: '16rem' }}
        />
        <button className="primary" disabled={busy || !name.trim() || !value.trim()} onClick={save}>
          Save key
        </button>
      </div>
      {state.keys.length > 0 && (
        <div style={{ display: 'grid', gap: '.4rem' }}>
          {state.keys.map((k) => (
            <div key={k.id} className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
              <button
                className={state.activeId === k.id ? 'primary' : ''}
                onClick={() => setActive(k.id)}
                style={{ minWidth: '9rem' }}
                disabled={busy || state.activeId === k.id}
              >
                {state.activeId === k.id ? 'Active' : 'Use this key'}
              </button>
              <div style={{ flex: 1 }}>
                <strong>{k.name}</strong>
                <div className="muted small">{k.value.slice(0, 4)}••••{k.value.slice(-4)}</div>
              </div>
              <button onClick={() => remove(k.id)} disabled={busy}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {message && <div className="notice bad" style={{ marginTop: '.5rem' }}>{message}</div>}
    </div>
  );
}

function Status({ setting }: { setting: Setting }) {
  if (setting.origin === 'unset') {
    return <span className="muted small">not set</span>;
  }
  return (
    <div style={{ textAlign: 'right', flex: 'none' }}>
      <code className="small">{setting.preview || '(set)'}</code>
      <div className="muted small">
        {setting.origin === 'saved' ? 'saved here' : 'from .env'}
      </div>
    </div>
  );
}
