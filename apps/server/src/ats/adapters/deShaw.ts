import type { Page } from 'playwright';
import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { stripHtml } from '../../discovery/sources/text.js';

/**
 * D. E. Shaw's own application site, behind its careers postings
 * (www.deshawindia.com/careers/<slug>-<id>, or www.deshaw.com for the US).
 *
 * Read from the live site in October 2026 (posting 7364, India):
 *   - The posting's "Apply Now" is a plain link to
 *     `https://www.apply.<site>/ApplicationPage1.html?entity=DESIS`, but its
 *     click handler first POSTs (empty, with credentials) to
 *     `<apply>/services/application/<n>` - 2 for DESIS (India), 1 for DESCO
 *     (US) - and then loads that link with `&source=Website&jobs=<id>`. That
 *     POST opens the application session; loading the page without it lands
 *     on application-error.html?errorCode=INVALID_LINK. This does the same.
 *   - The application is a React app split across pages: ApplicationPage1
 *     (basic info, resume), then ApplicationPage2 (position-specific
 *     questions) and SelfIdPage when the job needs them, then
 *     application-success.html. Fields are native inputs with `<label for>`.
 *   - Postings of hire type C514660 are apply-by-email; the site offers no
 *     form for them.
 *   - The final step has not been seen in a real run yet, so every
 *     application stops for review before it is sent.
 */

const APPLY_BY_EMAIL = 'C514660';
const SETTLE_MS = 20_000;

/** What the posting page said, kept for readJobMeta once the form is open. */
const postings = new WeakMap<Page, JobMeta>();

interface Site {
  apply: string;
  entity: 'DESIS' | 'DESCO';
  entityId: string;
  country?: string;
}

function siteFor(url: string): Site {
  return /deshawindia\.com$/i.test(new URL(url).hostname)
    ? { apply: 'https://www.apply.deshawindia.com', entity: 'DESIS', entityId: '2', country: 'India' }
    : { apply: 'https://www.apply.deshaw.com', entity: 'DESCO', entityId: '1' };
}

interface PostingData {
  id?: number;
  displayName?: string;
  hireType?: { id?: string };
  jobMetadata?: { jobLocations?: { name?: string }[] };
  jobDescription?: {
    websiteDescription?: string | null;
    responsibilities?: string | null;
    responsibilitiesHtml?: string | null;
    peopleWeAreLookingFor?: string[] | null;
    peopleWeAreLookingForHtml?: string | null;
  };
}

/** The posting's own data, from the `__NEXT_DATA__` its page hydrates from. */
async function readPosting(page: Page): Promise<PostingData | null> {
  return page.evaluate(() => {
    const raw = document.getElementById('__NEXT_DATA__')?.textContent;
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { props?: { pageProps?: { jobData?: unknown } } }).props?.pageProps?.jobData ?? null;
    } catch {
      return null;
    }
  }) as Promise<PostingData | null>;
}

function metaFrom(job: PostingData, site: Site): JobMeta {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const offices = (job.jobMetadata?.jobLocations ?? []).map((l) => clean(l.name)).filter(Boolean);
  const d = job.jobDescription ?? {};
  return {
    title: clean(job.displayName),
    company: 'D. E. Shaw',
    // The India site names cities only; say which country they are in.
    location: offices.length ? `${offices.join('; ')}${site.country ? `, ${site.country}` : ''}` : undefined,
    descriptionText: [
      d.websiteDescription,
      d.responsibilitiesHtml ? stripHtml(d.responsibilitiesHtml) : d.responsibilities,
      d.peopleWeAreLookingForHtml ? stripHtml(d.peopleWeAreLookingForHtml) : (d.peopleWeAreLookingFor ?? []).join('\n'),
    ]
      .map(clean)
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 30000),
  };
}

/** Wait until the React app has drawn the step's fields. Bounded. */
async function settle(page: Page): Promise<void> {
  await page
    .locator('form input:not([type="hidden"]), form select, form textarea, .form-field input')
    .first()
    .waitFor({ state: 'visible', timeout: SETTLE_MS })
    .catch(() => {});
}

export const deShawAdapter: AtsAdapter = {
  id: 'deshaw',

  matches(url) {
    return /^https?:\/\/(www\.)?(deshawindia|deshaw)\.com\/careers\/[^/?#]+-\d+(?:[/?#]|$)/i.test(url)
      || /^https?:\/\/www\.apply\.(deshawindia|deshaw)\.com\//i.test(url);
  },

  async openApplicationForm(page, url) {
    if (/^https?:\/\/www\.apply\./i.test(url)) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page);
      return;
    }
    const site = siteFor(url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const job = await readPosting(page);
    const id = job?.id ?? Number(new URL(url).pathname.match(/-(\d+)\/?$/)?.[1]);
    if (!id) throw new Error('D. E. Shaw posting page carries no job id; the posting may be closed.');
    if (job?.hireType?.id === APPLY_BY_EMAIL) {
      throw new Error('This D. E. Shaw posting takes applications by email only; there is no form to fill.');
    }
    if (job) postings.set(page, metaFrom(job, site));

    // What the site's own Apply Now does before it navigates.
    const ok = await page.evaluate(async ({ endpoint }) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-type': 'application/json' },
      }).catch(() => null);
      return !!res && res.ok;
    }, { endpoint: `${site.apply}/services/application/${site.entityId}` });
    if (!ok) throw new Error('D. E. Shaw\'s application site refused to open an application session.');

    const form = new URL(`${site.apply}/ApplicationPage1.html`);
    form.searchParams.set('entity', site.entity);
    form.searchParams.set('source', 'Website');
    form.searchParams.set('jobs', String(id));
    await page.goto(form.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page);
    if (/application-error\.html/i.test(page.url())) {
      const code = new URL(page.url()).searchParams.get('errorCode') ?? 'unknown';
      throw new Error(`D. E. Shaw's application site showed an error page (${code}).`);
    }
  },

  async readJobMeta(page): Promise<JobMeta> {
    const known = postings.get(page);
    if (known) return known;
    // Opened straight on the application site: it names no posting.
    return { title: '', company: 'D. E. Shaw', descriptionText: '' };
  },

  async settle(page) {
    await settle(page);
  },

  async extractForm(page) {
    return extractFields(page, { harvestComboboxOptions: true });
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    return {
      resume: files.find((f) => /resume|\bcv\b/i.test(fileHint(f))) ?? files[0],
      coverLetter: files.find((f) => /cover/i.test(fileHint(f))),
    };
  },

  async submit(page) {
    const button = page.getByRole('button', { name: /submit|send application|apply/i }).first();
    const target = (await button.count())
      ? button
      : page.locator('form button[type="submit"], form input[type="submit"]').first();
    if (!(await target.isVisible().catch(() => false))) {
      throw new Error('No submit button on the D. E. Shaw application page.');
    }
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click();
    await page.waitForURL(/application-success\.html/i, { timeout: 30_000 }).catch(() => {});
  },

  notes: [
    'Opens the application session the way the posting\'s Apply Now does, then fills D. E. Shaw\'s own multi-page form.',
    'Apply-by-email postings have no form and are refused up front.',
    'Always stops for review before submitting: the final step has not been seen in a real run yet.',
  ],
  alwaysReview: true,
};
