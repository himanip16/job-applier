import { prisma } from './db.js';

export type ApiProvider = 'anthropic' | 'gemini';

export interface NamedApiKey {
  id: string;
  name: string;
  value: string;
}

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

export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(EDITABLE_SETTINGS, k);

export const NAMED_API_KEY_KEYS = {
  anthropic: 'ANTHROPIC_API_KEYS',
  gemini: 'GEMINI_API_KEYS',
} as const;

export const NAMED_API_KEY_ACTIVE_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY_ACTIVE',
  gemini: 'GEMINI_API_KEY_ACTIVE',
} as const;

const cache = new Map<string, string>();
let loaded = false;

function parseNamedApiKeys(raw: string): NamedApiKey[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const value = typeof item.value === 'string' ? item.value.trim() : '';
      if (!id || !name || !value) return [];
      return [{ id, name, value }];
    });
  } catch {
    return [];
  }
}

export function readNamedApiKeys(provider: ApiProvider): NamedApiKey[] {
  const raw = secret(NAMED_API_KEY_KEYS[provider]);
  return parseNamedApiKeys(raw);
}

export function activeNamedApiKeyId(provider: ApiProvider): string | undefined {
  const explicit = secret(NAMED_API_KEY_ACTIVE_KEYS[provider]);
  if (explicit) return explicit;
  const keys = readNamedApiKeys(provider);
  return keys[0]?.id;
}

export function activeNamedApiKey(provider: ApiProvider): NamedApiKey | undefined {
  const keys = readNamedApiKeys(provider);
  const activeId = activeNamedApiKeyId(provider);
  return keys.find((k) => k.id === activeId) ?? keys[0];
}

export async function saveNamedApiKey(
  provider: ApiProvider,
  patch: { id?: string; name: string; value: string },
): Promise<NamedApiKey> {
  const trimmedName = patch.name.trim();
  const trimmedValue = patch.value.trim();
  if (!trimmedName || !trimmedValue) {
    throw new Error('API key name and value are both required.');
  }

  const nextKey: NamedApiKey = {
    id: patch.id || crypto.randomUUID(),
    name: trimmedName,
    value: trimmedValue,
  };

  // Use transaction to prevent race conditions with concurrent modifications
  const result = await prisma.$transaction(async (tx) => {
    const keysKey = NAMED_API_KEY_KEYS[provider];
    const activeKey = NAMED_API_KEY_ACTIVE_KEYS[provider];

    // Read current state from database within transaction
    const setting = await tx.setting.findUnique({ where: { key: keysKey } });
    const keys = setting ? parseNamedApiKeys(setting.value) : [];

    // Check for duplicate names (excluding the key being edited)
    const nameExists = keys.some((k) => k.id !== nextKey.id && k.name === trimmedName);
    if (nameExists) {
      throw new Error('An API key with this name already exists.');
    }

    // Check if there's an explicit active key BEFORE saving
    const activeSetting = await tx.setting.findUnique({ where: { key: activeKey } });
    const hasExplicitActiveKey = !!activeSetting?.value;

    const existing = keys.filter((k) => k.id !== nextKey.id);
    const updated = [...existing, nextKey].sort((a, b) => a.name.localeCompare(b.name));

    // Update keys
    await tx.setting.upsert({
      where: { key: keysKey },
      create: { key: keysKey, value: JSON.stringify(updated) },
      update: { value: JSON.stringify(updated) },
    });

    // Only set as active if there was no explicit active key before
    if (!hasExplicitActiveKey) {
      await tx.setting.upsert({
        where: { key: activeKey },
        create: { key: activeKey, value: nextKey.id },
        update: { value: nextKey.id },
      });
    }

    return { hasExplicitActiveKey };
  });

  // Update cache after successful transaction
  const keys = readNamedApiKeys(provider);
  cache.set(NAMED_API_KEY_KEYS[provider], JSON.stringify(keys));
  
  const activeId = activeNamedApiKeyId(provider);
  if (activeId) {
    cache.set(NAMED_API_KEY_ACTIVE_KEYS[provider], activeId);
  } else {
    cache.delete(NAMED_API_KEY_ACTIVE_KEYS[provider]);
  }

  return nextKey;
}

export async function setActiveApiKey(provider: ApiProvider, id: string): Promise<void> {
  // Use transaction to prevent race conditions
  await prisma.$transaction(async (tx) => {
    const keysKey = NAMED_API_KEY_KEYS[provider];
    const activeKey = NAMED_API_KEY_ACTIVE_KEYS[provider];

    // Verify the key exists in the saved list
    const setting = await tx.setting.findUnique({ where: { key: keysKey } });
    const keys = setting ? parseNamedApiKeys(setting.value) : [];
    if (!keys.some((k) => k.id === id)) {
      throw new Error('That API key is not in the saved list.');
    }

    // Set as active
    await tx.setting.upsert({
      where: { key: activeKey },
      create: { key: activeKey, value: id },
      update: { value: id },
    });
  });

  // Update cache after successful transaction
  cache.set(NAMED_API_KEY_ACTIVE_KEYS[provider], id);
}

export async function clearNamedApiKey(provider: ApiProvider, id: string): Promise<void> {
  // Use transaction to prevent race conditions with concurrent modifications
  await prisma.$transaction(async (tx) => {
    const keysKey = NAMED_API_KEY_KEYS[provider];
    const activeKey = NAMED_API_KEY_ACTIVE_KEYS[provider];

    // Read current state from database within transaction
    const setting = await tx.setting.findUnique({ where: { key: keysKey } });
    const keys = setting ? parseNamedApiKeys(setting.value) : [];
    const remaining = keys.filter((k) => k.id !== id);

    // Update keys
    if (remaining.length === 0) {
      await tx.setting.deleteMany({ where: { key: keysKey } });
    } else {
      await tx.setting.upsert({
        where: { key: keysKey },
        create: { key: keysKey, value: JSON.stringify(remaining) },
        update: { value: JSON.stringify(remaining) },
      });
    }

    // Handle active key
    const activeSetting = await tx.setting.findUnique({ where: { key: activeKey } });
    const activeId = activeSetting?.value;
    if (activeId === id) {
      await tx.setting.deleteMany({ where: { key: activeKey } });
      if (remaining[0]) {
        await tx.setting.upsert({
          where: { key: activeKey },
          create: { key: activeKey, value: remaining[0].id },
          update: { value: remaining[0].id },
        });
      }
    }
  });

  // Update cache after successful transaction
  const keys = readNamedApiKeys(provider);
  cache.set(NAMED_API_KEY_KEYS[provider], JSON.stringify(keys));
  
  const activeId = activeNamedApiKeyId(provider);
  if (activeId) {
    cache.set(NAMED_API_KEY_ACTIVE_KEYS[provider], activeId);
  } else {
    cache.delete(NAMED_API_KEY_ACTIVE_KEYS[provider]);
  }
}

/**
 * Fill the cache from the database. Call once at boot, before serving.
 *
 * A missing settings table is not an error worth crashing over: it means the
 * schema has not been pushed yet, and the boot-time schema check reports that
 * far better than a stack trace from here would.
 */
export async function loadSettings(): Promise<number> {
  try {
    // Clear cache before fetching to avoid race conditions with concurrent writes
    cache.clear();
    const rows = await prisma.setting.findMany();
    for (const row of rows) if (row.value) cache.set(row.key, row.value);
    loaded = true;
    return cache.size;
  } catch {
    // Don't mark as loaded on error - allows retry and prevents stale state
    return 0;
  }
}

/** The stored value, else the environment, else empty. */
function activeNamedApiKeyValueForKey(key: string): string | undefined {
  if (key === 'ANTHROPIC_API_KEY') return activeNamedApiKey('anthropic')?.value;
  if (key === 'GEMINI_API_KEY') return activeNamedApiKey('gemini')?.value;
  return undefined;
}

export function secret(key: string, ...envFallbacks: string[]): string {
  const activeNamed = activeNamedApiKeyValueForKey(key);
  if (activeNamed) return activeNamed;
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
  if (key === 'ANTHROPIC_API_KEY' && readNamedApiKeys('anthropic').length) return 'saved';
  if (key === 'GEMINI_API_KEY' && readNamedApiKeys('gemini').length) return 'saved';
  if (cache.get(key)) return 'saved';
  for (const name of [key, ...envFallbacks]) if (process.env[name]) return 'env';
  return 'unset';
}

export async function setSetting(key: string, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) return clearSetting(key);
  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key },
      create: { key, value: trimmed },
      update: { value: trimmed },
    });
  });
  // Update cache after successful transaction
  cache.set(key, trimmed);
}

/**
 * Remove a stored value.
 *
 * The environment then shows through again, which is deliberate: clearing a
 * key you typed into the UI should not also disable one that was already in
 * .env, and the settings page says which is in force.
 */
export async function clearSetting(key: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.setting.deleteMany({ where: { key } });
  });
  // Update cache after successful transaction
  cache.delete(key);
}

export function namedProviderState(provider: ApiProvider): {
  activeId: string | undefined;
  keys: NamedApiKey[];
} {
  return {
    activeId: activeNamedApiKeyId(provider),
    keys: readNamedApiKeys(provider),
  };
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
  if (value.length <= 12) return '••••';
  // Reveal only 2 characters at start and 2 at end for longer keys
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}
