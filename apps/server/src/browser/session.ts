import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config, artifactsDir } from '../lib/config.js';

/**
 * One persistent Chromium profile, reused across every run.
 *
 * This is deliberate, not laziness. A throwaway headless context is the single
 * strongest bot signal there is: no history, no cookies, no prior interaction,
 * and an automation-flagged user agent. A long-lived profile that has actually
 * been driven by a human accumulates the reputation that invisible reCAPTCHA
 * and similar score-based challenges are measuring, which is the difference
 * between a form that submits silently and one that throws up a challenge.
 */
let ctx: BrowserContext | null = null;

export async function getContext(): Promise<BrowserContext> {
  if (ctx) return ctx;
  await fs.mkdir(config.browserProfileDir, { recursive: true });
  // If a previous context died (crash, someone closed the window, the machine
  // slept), the cached handle would otherwise be handed out forever and every
  // run would fail with "browser has been closed".


  try {
    ctx = await launch();
  } catch (err) {
    const msg = (err as Error).message;
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      throw new Error(
        'Chromium is not downloaded yet. Playwright ships the library but not the browser. ' +
          'Run:  pnpm --filter @ja/server exec playwright install chromium  ' +
          '(the bare `npx playwright install` resolves a different copy of Playwright in a ' +
          'workspace and installs browsers the wrong version expects). ' +
          'If the download is blocked on your network, point CHROMIUM_EXECUTABLE_PATH at a ' +
          'Chromium you already have.',
      );
    }
    if (/ProcessSingleton|already in use/i.test(msg)) {
      throw new Error(
        `Another process is already using the browser profile at ${config.browserProfileDir}. ` +
          'Chromium allows one instance per profile, so the API server and a second run (or the ' +
          'test suite) cannot share one. Stop the other process, or point this one at its own ' +
          'BROWSER_PROFILE_DIR.',
      );
    }
    throw err;
  }

  // esbuild (which tsx uses) compiles arrow functions with `keepNames`, which
  // rewrites them as `__name(() => {...}, "fn")`. Playwright serialises the
  // function source and evaluates it inside the page, where `__name` does not
  // exist - so every page.evaluate throws ReferenceError under tsx but works
  // fine under tsc. Shimming it on the context fixes every page at once, and
  // is harmless when the bundler did not add the wrapper.
  await ctx.addInitScript(() => {
    const g = globalThis as unknown as { __name?: unknown };
    g.__name ??= <T>(fn: T) => fn;
  });

  ctx.setDefaultTimeout(20_000);
  ctx.setDefaultNavigationTimeout(45_000);
  ctx.once('close', () => { ctx = null; });
  return ctx;
}

function launch() {
  return chromium.launchPersistentContext(config.browserProfileDir, {
    headless: config.headless,
    ...(config.chromiumExecutablePath ? { executablePath: config.chromiumExecutablePath } : {}),
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    acceptDownloads: true,
    slowMo: config.actionDelayMs,
    args: [
      // Chromium advertises itself as automated by default; that flag alone is
      // enough for some bot filters.
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
}

export async function closeContext(): Promise<void> {
  await ctx?.close();
  ctx = null;
}

export async function newPage(): Promise<Page> {
  const c = await getContext();
  const page = await c.newPage();
  // navigator.webdriver is true under automation. Not a magic cloak, but
  // removing the obvious tell costs nothing.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return page;
}

/** Save a screenshot into the artifact store and return its relative path. */
export async function screenshot(page: Page, applicationId: string, label: string): Promise<string> {
  const dir = path.join(artifactsDir, applicationId);
  await fs.mkdir(dir, { recursive: true });
  const safe = label.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  const file = `${Date.now()}-${safe}.png`;
  await page.screenshot({ path: path.join(dir, file), fullPage: false });
  return path.join(applicationId, file);
}

export async function saveDom(page: Page, applicationId: string, label: string): Promise<string> {
  const dir = path.join(artifactsDir, applicationId);
  await fs.mkdir(dir, { recursive: true });
  const safe = label.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  const file = `${Date.now()}-${safe}.html`;
  await fs.writeFile(path.join(dir, file), await page.content(), 'utf8');
  return path.join(applicationId, file);
}
