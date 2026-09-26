import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EDITABLE_SETTINGS,
  clearNamedApiKey,
  clearSetting,
  isSettingKey,
  maskSecret,
  namedProviderState,
  readNamedApiKeys,
  saveNamedApiKey,
  secret,
  secretOrigin,
  setActiveApiKey,
  setSetting,
  type SettingKey,
} from '../lib/secrets.js';
import { provider, resetProvider, isConfigured } from '../llm/client.js';
import { activeModels } from '../llm/models.js';
import { firecrawlSearch, isFirecrawlConfigured } from '../discovery/firecrawl.js';

/**
 * Keys, from the UI.
 *
 * Editing a dotfile and restarting a server is a reasonable thing to ask of
 * the person who wrote the app and an unreasonable thing to ask of the person
 * using it. These endpoints put every key that gates a feature behind a text
 * box, and - more usefully - check the key actually works before saying it is
 * saved. "Saved" followed by a silent failure ten minutes later is worse than
 * no settings page at all.
 */
export function registerSettingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async () => ({
    settings: (Object.keys(EDITABLE_SETTINGS) as SettingKey[]).map((key) => describe(key)),
    // Masked: a saved key must never reach the browser in full.
    namedKeys: {
      anthropic: maskedProviderState('anthropic'),
      gemini: maskedProviderState('gemini'),
    },
    // What the current combination actually gets you, so the page can say
    // which features are live rather than leaving you to work it out.
    effect: {
      modelReady: isConfigured(),
      searchReady: isFirecrawlConfigured(),
      ...activeModels(),
    },
  }));

  app.post<{ Params: { provider: string } }>('/api/settings/keys/:provider', async (req, reply) => {
    const provider = z.enum(['anthropic', 'gemini']).parse(req.params.provider);
    const body = z
      .object({
        id: z.string().optional(),
        name: z.string().min(1),
        value: z.string().min(1),
      })
      .parse(req.body ?? {});

    const saved = await saveNamedApiKey(provider, body);
    resetProvider();
    return { key: saved, provider };
  });

  app.put<{ Params: { provider: string } }>('/api/settings/keys/:provider/active', async (req, reply) => {
    const provider = z.enum(['anthropic', 'gemini']).parse(req.params.provider);
    const body = z.object({ id: z.string().min(1) }).parse(req.body ?? {});
    await setActiveApiKey(provider, body.id);
    resetProvider();
    return { provider, activeId: body.id };
  });

  app.delete<{ Params: { provider: string; id: string } }>('/api/settings/keys/:provider/:id', async (req, reply) => {
    const provider = z.enum(['anthropic', 'gemini']).parse(req.params.provider);
    const id = z.string().min(1).parse(req.params.id);
    await clearNamedApiKey(provider, id);
    resetProvider();
    return { provider, id };
  });

  /**
   * Save one key and immediately prove it works.
   *
   * The check is the point of this endpoint. Set `verify: false` to skip it -
   * useful if you are offline, or if you would rather not spend the couple of
   * Firecrawl credits a live search costs.
   */
  app.put('/api/settings', async (req, reply) => {
    const body = z
      .object({
        key: z.string(),
        value: z.string(),
        verify: z.boolean().default(true),
      })
      .parse(req.body ?? {});

    if (!isSettingKey(body.key)) {
      return reply.code(400).send({ error: `"${body.key}" is not a setting this app uses.` });
    }
    const key = body.key;

    if (key === 'LLM_PROVIDER' && body.value.trim()) {
      const chosen = body.value.trim().toLowerCase();
      if (chosen !== 'gemini' && chosen !== 'anthropic') {
        return reply
          .code(400)
          .send({ error: 'Model provider must be "gemini", "anthropic", or blank to auto-detect.' });
      }
      await setSetting(key, chosen);
      resetProvider();
      return { setting: describe(key), check: { ok: true, detail: `Using ${chosen}.` } };
    }

    const previous = secret(key);
    await setSetting(key, body.value);
    // The cached SDK client holds the old key until it is thrown away.
    resetProvider();

    if (!body.verify || !body.value.trim()) {
      return { setting: describe(key), check: null };
    }

    const check = await verify(key);
    if (!check.ok) {
      // Do not leave a key in place that has just been shown not to work: the
      // next run would fail somewhere far less obvious than this page.
      if (previous) await setSetting(key, previous);
      else await clearSetting(key);
      resetProvider();
      return reply.code(400).send({ error: check.detail, setting: describe(key) });
    }

    return { setting: describe(key), check };
  });

  app.delete<{ Params: { key: string } }>('/api/settings/:key', async (req, reply) => {
    if (!isSettingKey(req.params.key)) {
      return reply.code(400).send({ error: `"${req.params.key}" is not a setting this app uses.` });
    }
    await clearSetting(req.params.key);
    resetProvider();
    return { setting: describe(req.params.key) };
  });
}

function maskedProviderState(provider: 'anthropic' | 'gemini') {
  const { activeId, keys } = namedProviderState(provider);
  return { activeId, keys: keys.map((k) => ({ id: k.id, name: k.name, preview: maskSecret(k.value) })) };
}

/** Everything about a setting except the value itself. */
function describe(key: SettingKey) {
  const meta = EDITABLE_SETTINGS[key];
  const value = secret(key, ...(key === 'GEMINI_API_KEY' ? ['GOOGLE_API_KEY'] : []));
  const origin = secretOrigin(key, ...(key === 'GEMINI_API_KEY' ? ['GOOGLE_API_KEY'] : []));
  return {
    key,
    label: meta.label,
    help: meta.help,
    where: meta.where,
    secret: meta.secret,
    origin,
    // Masked for the secrets; LLM_PROVIDER is not one, and hiding it would
    // just make the page harder to read.
    preview: meta.secret ? maskSecret(value) : value,
    set: Boolean(value),
  };
}

/** Does this key actually work? One real call, with a message worth reading. */
async function verify(key: SettingKey): Promise<{ ok: boolean; detail: string }> {
  try {
    if (key === 'FIRECRAWL_API_KEY') {
      // The cheapest real request the API offers. Two credits to find out now
      // instead of during a run is a good trade.
      await firecrawlSearch('software engineer', { limit: 1 });
      return { ok: true, detail: 'Key works. Job search is on.' };
    }

    const models = await provider().listModels();
    if (!models.length) {
      return {
        ok: false,
        detail:
          'That key was rejected, or it cannot list any models. Check you copied all of it, and ' +
          'that the key is enabled for the Generative Language API.',
      };
    }
    const active = activeModels();
    const reachable = models.includes(active.writing);
    return {
      ok: true,
      detail: reachable
        ? `Key works. ${models.length} models available, including ${active.writing}.`
        : `Key works (${models.length} models available), but the configured model ` +
          `"${active.writing}" is not one of them. Pick a different one on the Models page.`,
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
