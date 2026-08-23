import { prisma } from './db.js';

/**
 * Settings that can be changed while the app is running.
 *
 * Everything else in config.ts is read from the environment once, at import,
 * which is right for a port number and wrong for an API key: getting the app
 * working should not require finding a text editor, editing a dotfile and
 * restarting a process. So the keys live in the database, and this module is
 * the overlay that sits in front of the environment.
 *
 * Reads are synchronous and hit an in-memory cache, because `config.geminiApiKey`
 * is read on paths that cannot be made async without touching everything. The
 * cache is filled once at boot and updated on every write, so it cannot go
 * stale within a process. Two servers against one database would drift until
 * restart; there is only ever one here.
 *
 * Honest about what this is: plaintext in your own Postgres, exactly the trust
 * level of the .env file it replaces. It is not a secret manager, and the
 * values are never sent back to the browser once saved.
 */

/** The settings the UI is allowed to write, and what they are for. */
export const EDITABLE_SETTINGS = {
  GEMINI_API_KEY: {
    label: 'Gemini API key',
    help: 'Free tier. Writes cover letters, judges fit, and grounds resume keywords.',
    where: 'aistudio.google.com/apikey',
    secret: true,
  },
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API key',
    help: 'Alternative to Gemini. Billed separately from a Claude subscription.',
    where: 'console.anthropic.com/settings/keys',
    secret: true,
  },
  FIRECRAWL_API_KEY: {
    label: 'Firecrawl API key',
    help: 'Lets "Find jobs for me" search without you naming companies.',
    where: 'firecrawl.dev',
    secret: true,
  },
  LLM_PROVIDER: {
    label: 'Model provider',
    help: 'Leave blank to use whichever key is set. Gemini wins if both are.',
    where: '',
    secret: false,
  },
} as const;

export type SettingKey = keyof typeof EDITABLE_SETTINGS;

export const isSettingKey = (k: string): k is SettingKey => k in EDITABLE_SETTINGS;

const cache = new Map<string, string>();
let loaded = false;

/**
 * Fill the cache from the database. Call once at boot, before serving.
 *
 * A missing settings table is not an error worth crashing over: it means the
 * schema has not been pushed yet, and the boot-time schema check reports that
 * far better than a stack trace from here would.
 */
export async function loadSettings(): Promise<number> {
  try {
    const rows = await prisma.setting.findMany();
    cache.clear();
    for (const row of rows) if (row.value) cache.set(row.key, row.value);
    loaded = true;
    return cache.size;
  } catch {
    loaded = true;
    return 0;
  }
}

/** The stored value, else the environment, else empty. */
export function secret(key: string, ...envFallbacks: string[]): string {
  const stored = cache.get(key);
  if (stored) return stored;
  for (const name of [key, ...envFallbacks]) {
    const fromEnv = process.env[name];
    if (fromEnv) return fromEnv;
  }
  return '';
}

/** Where a value is coming from, so the UI can say so rather than guess. */
export function secretOrigin(key: string, ...envFallbacks: string[]): 'saved' | 'env' | 'unset' {
  if (cache.get(key)) return 'saved';
  for (const name of [key, ...envFallbacks]) if (process.env[name]) return 'env';
  return 'unset';
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) return clearSetting(key);
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: trimmed },
    update: { value: trimmed },
  });
  cache.set(key, trimmed);
}

/**
 * Remove a stored value.
 *
 * The environment then shows through again, which is deliberate: clearing a
 * key you typed into the UI should not also disable one that was already in
 * .env, and the settings page says which is in force.
 */
export async function clearSetting(key: SettingKey): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
  cache.delete(key);
}

export const settingsLoaded = (): boolean => loaded;

/**
 * Enough of the value to recognise it, and not enough to use it.
 *
 * A saved key must never come back to the browser in full - it would then sit
 * in devtools, in the page source, and in any screenshot of this page.
 */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
