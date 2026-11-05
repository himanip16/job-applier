import type { Page } from 'playwright';
import type { AtsAdapter, JobMeta } from '../types.js';
import { fileHint } from '../types.js';
import { extractFields } from '../../browser/extract.js';

/**
 * iCIMS candidate portals (`<portal>.icims.com/jobs/<id>/...`), and the Jibe
 * job sites in front of them (jobs.booking.com/<tenant>/jobs/<id>).
 *
 * Checked live on Booking Holdings' portal (careers-holdings-workingatbooking)
 * in October 2026:
 *   - The portal page is a wrapper; everything is drawn in
 *     `#icims_content_iframe`, the same URL plus `in_iframe=1`. Loaded at the
 *     top, that page bounces itself to the wrapper: an inline script sets
 *     `window.top.location.href` to the URL minus `in_iframe=1` whenever the
 *     top URL carries it. The form, extractor and filler all work on the
 *     page, not frames, so the run opens the `in_iframe=1` page at the top and
 *     drops that one line from iCIMS' documents (see `stopFrameBounce`). Every
 *     link and form action inside carries `in_iframe=1`, so the run stays in
 *     that view throughout.
 *   - Jibe's posting links its Apply button to `<portal>/jobs/<id>/login`.
 *     Booking has several portals (careers-holdings-..., external-...); the
 *     posting says which.
 *   - The first step is "Enter Your Information": `#email`, a Data Privacy
 *     Options select (`#gdpr_consent_type`) and an "I've read and understood"
 *     box (`#accept_gdpr`). Next stays disabled until both are answered. The
 *     run picks "I just want to be considered for this job" (the narrower
 *     consent) and ticks the box before Next is looked for.
 *   - Next runs an invisible hCaptcha before the form posts. It may pass
 *     silently; if it shows a challenge, that is for the person to solve.
 *   - The steps after the email were not seen, so every run stops for review.
 */

const FRAME_BOUNCE = /window\.top\.location\.href\s*=\s*icims_stripIFrameParameter\(windowUrl\);?/g;
const ROUTED = Symbol('icims-routed');
const SETTLE_MS = 20_000;

/** Job meta read from the Jibe posting, which the iCIMS login page lacks. */
const postingMeta = new WeakMap<Page, JobMeta>();

function isPortal(url: string): boolean {
  return /^https?:\/\/[^/]+\.icims\.com\/jobs\//i.test(url);
}

function isJibe(url: string): boolean {
  return /^https?:\/\/jobs\.booking\.com\/[^/]+\/jobs\/\d+/i.test(url);
}

/** `<portal>/jobs/<id>/login?in_iframe=1`, from any portal URL for the job. */
function framedLoginUrl(url: string): string {
  const u = new URL(url);
  const id = u.pathname.match(/\/jobs\/(\d+)/)?.[1];
  if (!id) throw new Error(`No iCIMS job id in ${url}.`);
  return `${u.origin}/jobs/${id}/login?in_iframe=1`;
}

/**
 * Keep iCIMS' framed pages at the top: serve its documents without the line
 * that sends the top window to the wrapper. Redirects pass through unfollowed,
 * so the browser keeps its own URL and every hop comes back through here.
 */
async function stopFrameBounce(page: Page): Promise<void> {
  const tagged = page as Page & { [ROUTED]?: boolean };
  if (tagged[ROUTED]) return;
  tagged[ROUTED] = true;
  await page.route(/^https:\/\/[^/]+\.icims\.com\//i, async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch({ maxRedirects: 0 }).catch(() => null);
    if (!response) return route.continue();
    const type = response.headers()['content-type'] ?? '';
    if (!/text\/html/i.test(type)) return route.fulfill({ response });
    const body = await response.text();
    return route.fulfill({ response, body: body.replace(FRAME_BOUNCE, '/* ja: stay framed */') });
  });
}

/** Wait for the iCIMS step to draw. Bounded. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_MS }).catch(() => {});
  await page
    .locator('.iCIMS_MainWrapper, #enterEmailForm, form')
    .first()
    .waitFor({ state: 'visible', timeout: SETTLE_MS })
    .catch(() => {});
}

/** Answer the privacy step that keeps Next disabled. */
async function answerPrivacy(page: Page): Promise<void> {
  const select = page.locator('#gdpr_consent_type').first();
  if (await select.isVisible().catch(() => false)) {
    const value = await select.evaluate((el) => (el as HTMLSelectElement).value);
    if (!value) {
      const options = await select.evaluate((el) =>
        Array.from((el as HTMLSelectElement).options)
          .filter((o) => o.value)
          .map((o) => ({ value: o.value, label: (o.textContent ?? '').trim() })),
      );
      const pick = options.find((o) => /just .*this job|only .*this (job|position)/i.test(o.label)) ?? options[0];
      if (pick) await select.selectOption(pick.value);
    }
  }
  const box = page.locator('#accept_gdpr').first();
  if ((await box.isVisible().catch(() => false)) && !(await box.isChecked().catch(() => true))) {
    await box.check().catch(() => box.click());
  }
}

export const icimsAdapter: AtsAdapter = {
  id: 'icims',

  matches(url) {
    return isPortal(url) || isJibe(url);
  },

  async openApplicationForm(page, url) {
    let portalUrl = url;
    if (isJibe(url)) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const apply = page.locator('a[href*=".icims.com/jobs/"]:not([href*="loginOnly"])').first();
      await apply.waitFor({ state: 'attached', timeout: SETTLE_MS });
      portalUrl = (await apply.getAttribute('href')) ?? '';
      if (!isPortal(portalUrl)) throw new Error('The posting has no iCIMS Apply link.');
      postingMeta.set(page, await readJibeMeta(page));
    }
    await stopFrameBounce(page);
    await page.goto(framedLoginUrl(portalUrl), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page);
  },

  async readJobMeta(page): Promise<JobMeta> {
    const fromPosting = postingMeta.get(page);
    if (fromPosting) return fromPosting;
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      // The job page: "Senior Platform Engineer I in Bangalore, Karnataka |
      // Careers at Bangalore BH". The login page says only "Login | ...", and
      // empty values keep what the lead already has.
      const [head] = document.title.split(/\s+\|\s+/, 1);
      const m = head?.match(/^(.*?)\s+in\s+(.+)$/);
      return {
        title: clean(m?.[1]),
        company: '',
        location: clean(m?.[2]) || undefined,
        descriptionText: clean(document.querySelector('.iCIMS_JobContent')?.textContent).slice(0, 30000),
      };
    });
  },

  async settle(page) {
    await settle(page);
  },

  async afterWall(page) {
    await settle(page);
  },

  async extractForm(page) {
    const fields = await extractFields(page);
    // Answered by beforeAdvance; the person is not asked.
    return fields.filter((f) => !/gdpr_consent_type|accept_gdpr/.test(`${f.name ?? ''} ${f.selector}`));
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    return {
      resume: files.find((f) => /resume|\bcv\b/i.test(fileHint(f))) ?? files[0],
      coverLetter: files.find((f) => /cover/i.test(fileHint(f))),
    };
  },

  async beforeAdvance(page) {
    await answerPrivacy(page);
  },

  async submit(page) {
    const target = page
      .locator('input[type="submit"], button[type="submit"]')
      .filter({ hasNot: page.locator('[disabled]') })
      .last();
    const button = (await target.count())
      ? target
      : page.getByRole('button', { name: /submit|apply/i }).first();
    if (!(await button.isVisible().catch(() => false))) {
      throw new Error('No submit button on the iCIMS step.');
    }
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  },

  notes: [
    "Opens iCIMS' framed page at the top level so the form is in the page, not an iframe.",
    'Answers the Data Privacy Options step with "just this job" and ticks "I\'ve read and understood".',
    'hCaptcha (invisible) runs on Next; a challenge, if shown, is yours to solve.',
    'Steps after the email were not seen live yet, so every run stops for review.',
  ],

  alwaysReview: true,
};

async function readJibeMeta(page: Page): Promise<JobMeta> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    type Posting = {
      '@type'?: string;
      title?: string;
      description?: string;
      hiringOrganization?: { name?: string };
      jobLocation?: Array<{ address?: { addressLocality?: string; addressCountry?: string } }> | { address?: { addressLocality?: string; addressCountry?: string } };
    };
    let posting: Posting | undefined;
    for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const data = JSON.parse(s.textContent ?? '') as Posting | Posting[];
        posting = (Array.isArray(data) ? data : [data]).find((d) => d['@type'] === 'JobPosting');
        if (posting) break;
      } catch {
        /* not JSON */
      }
    }
    const loc = Array.isArray(posting?.jobLocation) ? posting?.jobLocation[0] : posting?.jobLocation;
    const place = [loc?.address?.addressLocality, loc?.address?.addressCountry].filter(Boolean).join(', ');
    // Parsed, not set as innerHTML on this page, so nothing in it runs.
    const body = new DOMParser().parseFromString(posting?.description ?? '', 'text/html').body;
    return {
      title: clean(posting?.title) || clean(document.querySelector('h1')?.textContent) || 'Unknown role',
      company: clean(posting?.hiringOrganization?.name),
      location: place || undefined,
      descriptionText: clean(body.textContent).slice(0, 30000),
    };
  });
}
