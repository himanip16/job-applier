import type { Page } from 'playwright';
import type { AtsAdapter } from './types.js';
import { adapterFor } from './registry.js';

/** How long a careers page gets to inject its application iframe. */
const EMBED_WAIT_MS = 10_000;

/**
 * A company careers page that is really an ATS form in an iframe.
 *
 * mongodb.com/careers/jobs/<id> is a Greenhouse application inside
 * `iframe#grnhse_iframe`. The generic adapter looks at the top document, sees
 * a job description and no inputs, and gives up - when the same form, opened
 * at the iframe's own address, is one the Greenhouse adapter drives well. So
 * before settling for generic, look for a frame a specific adapter claims.
 *
 * Returns null when there is none, leaving the page where it was loaded.
 */
export async function findEmbeddedAts(
  page: Page,
  url: string,
): Promise<{ url: string; adapter: AtsAdapter } | null> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // The embed is usually injected by a script after load, so poll briefly.
  const deadline = Date.now() + EMBED_WAIT_MS;
  while (Date.now() < deadline) {
    const sources = [
      ...page.frames().map((f) => f.url()),
      ...(await page
        .locator('iframe[src]')
        .evaluateAll((els) => els.map((e) => (e as HTMLIFrameElement).src))
        .catch(() => [] as string[])),
    ];
    for (const src of sources) {
      if (!/^https?:/.test(src)) continue;
      const adapter = adapterFor(src);
      if (adapter.id !== 'generic') return { url: src, adapter };
    }
    await page.waitForTimeout(500);
  }
  return null;
}
