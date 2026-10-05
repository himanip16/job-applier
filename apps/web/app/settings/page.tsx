'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import s from './settings.module.css';

/**
 * Keys, without a text editor.
 *
 * One AI key is in use at a time, across providers. The page used to show a
 * key box per provider, a separate list of saved keys per provider, and a
 * "model provider" setting that decided between them - three controls that
 * could disagree about which key was actually running. Now there is one list,
 * one "In use", and choosing a key chooses its provider with it.
 */

type Provider = 'gemini' | 'anthropic';

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
  /** Masked by the server. `value` is only read if an older server sends it. */
  preview?: string;
  value?: string;
}

interface NamedKeySet {
  activeId?: string;
  keys: NamedKey[];
}

interface SettingsResponse {
  settings: Setting[];
  namedKeys: Record<Provider, NamedKeySet>;
  effect: Effect;
}

/** One row in the AI key list: a saved key, or a key that only exists in .env. */
interface KeyRow {
  id: string;
  provider: Provider;
  name: string;
  masked: string;
  fromEnv: boolean;
}

const PROVIDER_NAME: Record<Provider, string> = { gemini: 'Gemini', anthropic: 'Anthropic' };
const ENV_KEY: Record<Provider, string> = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

const mask = (v: string) => (v.length <= 8 ? '••••' : `${v.slice(0, 4)}••••${v.slice(-4)}`);

/** Both providers' keys have recognisable prefixes; guess so you do not have to say. */
function detectProvider(value: string): Provider | null {
  const v = value.trim();
  if (/^sk-ant-/.test(v)) return 'anthropic';
  if (/^(AIza|AQ\.)/.test(v)) return 'gemini';
  return null;
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api<SettingsResponse>('/api/settings'));
  }, []);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  if (!data) {
    return (
      <div className={s.page}>
        <Header />
        {error ? <div className="notice bad">{error}</div> : <div className="muted small">Loading…</div>}
      </div>
    );
  }

  const byKey = new Map(data.settings.map((x) => [x.key, x]));
  const rows = keyRows(data, byKey);
  const inUse = activeRow(data, rows);

  return (
    <div className={s.page}>
      <Header />
      <WhatWorks effect={data.effect} inUse={inUse} />
      <AiKeys data={data} rows={rows} inUse={inUse} onChange={load} />
      {byKey.get('FIRECRAWL_API_KEY') && (
        <SearchKey setting={byKey.get('FIRECRAWL_API_KEY')!} onChange={load} />
      )}
      {byKey.get('JOB_SITE_PASSWORD') && (
        <JobSiteAccount setting={byKey.get('JOB_SITE_PASSWORD')!} onChange={load} />
      )}
      <p className={s.foot}>
        Keys are stored in plain text in the <code>settings</code> table of your own Postgres
        database — the same protection as the <code>.env</code> file they replace. This page only
        ever shows the first and last four characters. A key still set in <code>.env</code> keeps
        working and is labelled as coming from there.
      </p>
    </div>
  );
}

function Header() {
  return (
    <header className={s.header}>
      <h1>Keys and settings</h1>
      <p>
        Paste a key and it is used straight away — no restart, no editing files. One AI key is in
        use at a time; switch whenever one runs out of free quota.
      </p>
    </header>
  );
}

function keyRows(data: SettingsResponse, byKey: Map<string, Setting>): KeyRow[] {
  const rows: KeyRow[] = [];
  for (const provider of ['gemini', 'anthropic'] as Provider[]) {
    const saved = data.namedKeys[provider]?.keys ?? [];
    for (const k of saved) {
      rows.push({
        id: k.id,
        provider,
        name: k.name,
        masked: k.preview ?? (k.value ? mask(k.value) : '••••'),
        fromEnv: false,
      });
    }
    const env = byKey.get(ENV_KEY[provider]);
    if (!saved.length && env?.origin === 'env') {
      rows.push({ id: `env:${provider}`, provider, name: `${PROVIDER_NAME[provider]} key`, masked: env.preview, fromEnv: true });
    }
  }
  return rows;
}

/** The one key actually answering model calls, if any. */
function activeRow(data: SettingsResponse, rows: KeyRow[]): KeyRow | undefined {
  if (!data.effect.modelReady) return undefined;
  const provider = data.effect.provider as Provider;
  const activeId = data.namedKeys[provider]?.activeId;
  return (
    rows.find((r) => r.provider === provider && r.id === activeId) ??
    rows.find((r) => r.provider === provider)
  );
}

function WhatWorks({ effect, inUse }: { effect: Effect; inUse?: KeyRow }) {
  return (
    <section className={s.status} aria-label="What works right now">
      <Tile
        on={effect.modelReady}
        title="Writing and judging"
        detail={
          effect.modelReady && inUse
            ? `${inUse.name} · ${effect.writing}`
            : 'Add an AI key below'
        }
      />
      <Tile
        on={effect.searchReady}
        title="Find jobs for me"
        detail={effect.searchReady ? 'Firecrawl connected' : 'Add a Firecrawl key below'}
      />
      <Tile on title="Form filling and tracking" detail="Always on — no key needed" />
    </section>
  );
}

function Tile({ on, title, detail }: { on: boolean; title: string; detail: string }) {
  return (
    <div className={s.tile}>
      <span className={`${s.dot} ${on ? s.dotOn : ''}`} aria-hidden />
      <div>
        <div className={s.tileTitle}>{title}</div>
        <div className={s.tileDetail}>
          <span className="sr-only">{on ? 'On. ' : 'Off. '}</span>
          {detail}
        </div>
      </div>
    </div>
  );
}

function AiKeys({
  data,
  rows,
  inUse,
  onChange,
}: {
  data: SettingsResponse;
  rows: KeyRow[];
  inUse?: KeyRow;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  async function run(label: string, work: () => Promise<void>, done?: string) {
    setBusy(label);
    setMessage(null);
    try {
      await work();
      await onChange();
      if (done) setMessage({ ok: true, text: done });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  /** Using a key means using its provider: the two are chosen together. */
  async function activate(row: Pick<KeyRow, 'id' | 'provider' | 'fromEnv'>) {
    if (!row.fromEnv) {
      await api(`/api/settings/keys/${row.provider}/active`, {
        method: 'PUT',
        body: JSON.stringify({ id: row.id }),
      });
    }
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ key: 'LLM_PROVIDER', value: row.provider }),
    });
  }

  async function remove(row: KeyRow) {
    await api(`/api/settings/keys/${row.provider}/${row.id}`, { method: 'DELETE' });
    if (inUse?.id !== row.id) return;
    // The key in use is gone: hand over to another one rather than leave
    // the app pointed at a provider with nothing in it.
    const next = rows.find((r) => r.id !== row.id && r.provider === row.provider) ??
      rows.find((r) => r.id !== row.id);
    if (next) await activate(next);
    else await api('/api/settings/LLM_PROVIDER', { method: 'DELETE' });
  }

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <h2>AI key</h2>
          <p>
            Writes answers and cover letters, scores jobs, and tailors your resume. Keep a few and
            switch when one hits its limit — only the one marked <strong>In use</strong> is called.
          </p>
        </div>
        {!adding && (
          <button className={`primary ${s.pill}`} onClick={() => setAdding(true)}>
            Add a key
          </button>
        )}
      </div>

      <div className={s.list}>
        {rows.length === 0 && !adding && (
          <div className={s.empty}>No AI key yet. Gemini has a free tier — add one to get started.</div>
        )}
        {rows.map((row) => {
          const active = inUse?.id === row.id && inUse.provider === row.provider;
          return (
            <div key={`${row.provider}:${row.id}`} className={`${s.row} ${active ? s.rowActive : ''}`}>
              <span
                className={`${s.dot} ${row.provider === 'gemini' ? s.dotGemini : s.dotAnthropic}`}
                aria-hidden
              />
              <div className={s.rowMain}>
                <span className={s.rowName}>{row.name}</span>
                <span className={s.rowMeta}>
                  {PROVIDER_NAME[row.provider]} · <code>{row.masked}</code>
                  {row.fromEnv && ' · from .env'}
                </span>
              </div>
              {active ? (
                <span className={s.inUse}>
                  <Check /> In use
                </span>
              ) : (
                <div className={s.actions}>
                  <button
                    className={s.pill}
                    disabled={busy !== null}
                    onClick={() =>
                      run(`use:${row.id}`, () => activate(row), `Now using ${row.name}.`)
                    }
                  >
                    {busy === `use:${row.id}` ? 'Switching…' : 'Use this key'}
                  </button>
                </div>
              )}
              {!row.fromEnv && (
                <button
                  className={s.quiet}
                  disabled={busy !== null}
                  aria-label={`Remove ${row.name}`}
                  title="Remove this key"
                  onClick={() => {
                    if (confirm(`Remove "${row.name}"? This cannot be undone.`)) {
                      void run(`rm:${row.id}`, () => remove(row), `Removed ${row.name}.`);
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}
      </div>

      {adding && (
        <AddKey
          existing={rows}
          onCancel={() => setAdding(false)}
          onSaved={async (row) => {
            await activate(row);
            await onChange();
            setAdding(false);
            setMessage({ ok: true, text: `Saved ${row.name} and switched to it.` });
          }}
        />
      )}

      {message && (
        <div className={`notice ${message.ok ? 'good' : 'bad'} ${s.message}`} role="status">
          {message.text}
        </div>
      )}
      {data.effect.modelReady && !inUse && (
        <div className={`notice ${s.message}`}>
          A key is working but is not in the list above. It may come from an older setting.
        </div>
      )}
    </section>
  );
}

function AddKey({
  existing,
  onCancel,
  onSaved,
}: {
  existing: KeyRow[];
  onCancel: () => void;
  onSaved: (row: KeyRow) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [chosen, setChosen] = useState<Provider>('gemini');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detected = detectProvider(value);
  const provider = detected ?? chosen;
  const fallbackName = `${PROVIDER_NAME[provider]} key ${existing.filter((r) => r.provider === provider).length + 1}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const finalName = name.trim() || fallbackName;
      const r = await api<{ key: { id: string } }>(`/api/settings/keys/${provider}`, {
        method: 'POST',
        body: JSON.stringify({ name: finalName, value: value.trim() }),
      });
      await onSaved({ id: r.key.id, provider, name: finalName, masked: mask(value.trim()), fromEnv: false });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={s.add} onSubmit={save}>
      <div className={s.fields}>
        <label>
          Name
          <input
            placeholder={fallbackName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          API key
          <input
            type="password"
            placeholder="Paste your key"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </label>
      </div>
      <div className={s.addFoot}>
        <span className={s.hint}>
          {detected ? (
            <>Looks like a {PROVIDER_NAME[detected]} key.</>
          ) : (
            <span className={s.inline}>
              Provider
              <select value={chosen} onChange={(e) => setChosen(e.target.value as Provider)}>
                <option value="gemini">Gemini (free tier)</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </span>
          )}{' '}
          Get one at{' '}
          <a
            href={provider === 'gemini' ? 'https://aistudio.google.com/apikey' : 'https://console.anthropic.com/settings/keys'}
            target="_blank"
            rel="noreferrer"
          >
            {provider === 'gemini' ? 'aistudio.google.com' : 'console.anthropic.com'}
          </a>
          .
        </span>
        <div className={s.inline}>
          <button type="button" className={`ghost ${s.pill}`} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={`primary ${s.pill}`} disabled={busy || !value.trim()}>
            {busy ? 'Saving…' : 'Save and use'}
          </button>
        </div>
      </div>
      {error && <div className="notice bad">{error}</div>}
    </form>
  );
}

function SearchKey({ setting, onChange }: { setting: Setting; onChange: () => Promise<void> }) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(!setting.set);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ check: { ok: boolean; detail: string } | null }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: setting.key, value, verify: true }),
      });
      setValue('');
      setEditing(false);
      setResult(r.check ?? { ok: true, detail: 'Saved.' });
      await onChange();
    } catch (err) {
      setResult({ ok: false, detail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirm('Remove the Firecrawl key? "Find jobs for me" stops working until you add one.')) return;
    setBusy(true);
    setResult(null);
    try {
      await api(`/api/settings/${setting.key}`, { method: 'DELETE' });
      await onChange();
      setEditing(true);
    } catch (err) {
      setResult({ ok: false, detail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <h2>Job search key</h2>
          <p>
            Lets <strong>Find jobs for me</strong> search the web without you naming companies.
            Checked with one real search when you save it (about two Firecrawl credits).
          </p>
        </div>
      </div>

      {setting.set && !editing ? (
        <div className={`${s.row} ${s.rowActive}`}>
          <span className={`${s.dot} ${s.dotFirecrawl}`} aria-hidden />
          <div className={s.rowMain}>
            <span className={s.rowName}>Firecrawl</span>
            <span className={s.rowMeta}>
              <code>{setting.preview}</code>
              {setting.origin === 'env' && ' · from .env'}
            </span>
          </div>
          <span className={s.inUse}>
            <Check /> Connected
          </span>
          <button className={s.pill} disabled={busy} onClick={() => setEditing(true)}>
            Replace
          </button>
          {setting.origin === 'saved' && (
            <button className={s.quiet} disabled={busy} onClick={clear}>
              Remove
            </button>
          )}
        </div>
      ) : (
        <form className={s.inline} onSubmit={save}>
          <input
            type="password"
            placeholder="Paste your Firecrawl key (fc-…)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Firecrawl API key"
          />
          {setting.set && (
            <button type="button" className={`ghost ${s.pill}`} onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="submit" className={`primary ${s.pill}`} disabled={busy || !value.trim()}>
            {busy ? 'Checking…' : 'Save and check'}
          </button>
        </form>
      )}
      {!setting.set && (
        <p className={s.hint} style={{ marginTop: '.5rem' }}>
          Get one at{' '}
          <a href="https://firecrawl.dev" target="_blank" rel="noreferrer">firecrawl.dev</a> — the
          free tier is enough for a personal job hunt.
        </p>
      )}

      {result && (
        <div className={`notice ${result.ok ? 'good' : 'bad'} ${s.message}`} role="status">
          {result.detail}
        </div>
      )}
    </section>
  );
}

/**
 * The password job sites' own accounts use (Workday's "Create Account").
 * Paired with the profile email; filled by plain DOM code, never shown to a model.
 */
function JobSiteAccount({ setting, onChange }: { setting: Setting; onChange: () => Promise<void> }) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(!setting.set);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ key: setting.key, value, verify: false }),
      });
      setValue('');
      setEditing(false);
      setResult({ ok: true, detail: 'Saved. Account walls are signed in automatically from now on.' });
      await onChange();
    } catch (err) {
      setResult({ ok: false, detail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirm('Remove the job site password? Account walls will wait for you again.')) return;
    setBusy(true);
    setResult(null);
    try {
      await api(`/api/settings/${setting.key}`, { method: 'DELETE' });
      await onChange();
      setEditing(true);
    } catch (err) {
      setResult({ ok: false, detail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <h2>Job site accounts</h2>
          <p>
            When an application asks you to <strong>Create Account</strong> or <strong>Sign In</strong>{' '}
            (Workday and similar), it is filled with your profile email and this password. If the
            account already exists it signs in instead. Google, Microsoft and Okta sign-ins still
            wait for you.
          </p>
        </div>
      </div>

      {setting.set && !editing ? (
        <div className={`${s.row} ${s.rowActive}`}>
          <span className={`${s.dot} ${s.dotFirecrawl}`} aria-hidden />
          <div className={s.rowMain}>
            <span className={s.rowName}>Password</span>
            <span className={s.rowMeta}>
              <code>••••••••</code>
              {setting.origin === 'env' && ' · from .env'}
            </span>
          </div>
          <span className={s.inUse}>
            <Check /> Saved
          </span>
          <button className={s.pill} disabled={busy} onClick={() => setEditing(true)}>
            Replace
          </button>
          {setting.origin === 'saved' && (
            <button className={s.quiet} disabled={busy} onClick={clear}>
              Remove
            </button>
          )}
        </div>
      ) : (
        <form className={s.inline} onSubmit={save}>
          <input
            type="password"
            placeholder="Password for job site accounts"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            aria-label="Job site account password"
          />
          {setting.set && (
            <button type="button" className={`ghost ${s.pill}`} onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="submit" className={`primary ${s.pill}`} disabled={busy || !value.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
      {!setting.set && (
        <p className={s.hint} style={{ marginTop: '.5rem' }}>
          Most sites want 8+ characters with upper and lower case, a number and a symbol.
        </p>
      )}

      {result && (
        <div className={`notice ${result.ok ? 'good' : 'bad'} ${s.message}`} role="status">
          {result.detail}
        </div>
      )}
    </section>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
