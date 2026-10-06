import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { openApplicationForm } from '../../browser/openForm.js';
import { stripHtml } from '../../discovery/sources/text.js';

/**
 * Rippling ATS (ats.rippling.com/<board>/jobs/<uuid>).
 *
 * The posting and the application are two URLs; the form lives at
 * `.../jobs/<uuid>/apply?step=application`, so we go straight there rather
 * than hunting for an Apply button. One <form>, generated names (`xhJwukk_mQ`)
 * that mean nothing, but every control has a `data-testid` and an
 * aria-labelledby caption.
 *
 * Its dropdowns are the trap: each carries a generic aria-label ("Search",
 * "Select...", "textbox") next to an aria-labelledby that names the real
 * question. Gender, race and veteran status are <div role="combobox">, not
 * inputs - nothing to type into, the options are clicked.
 *
 * The apply page has no description and no <h1>, so job meta comes from the
 * same board API discovery uses (checked live 2026-10-06).
 */
export const ripplingAdapter: AtsAdapter = {
  id: 'rippling',

  matches(url) {
    return /ats\.rippling\.com\//i.test(url);
  },

  async openApplicationForm(page, url) {
    await openApplicationForm(page, applyUrl(url), {
      applyPatterns: [/^apply( now| for this job)?$/i],
      formSelectors: ['form [data-testid^="input-"]'],
    });
  },

  async readJobMeta(page): Promise<JobMeta> {
    const ref = jobRef(page.url());
    if (ref) {
      try {
        const res = await fetch(
          `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(ref.board)}/jobs/${ref.uuid}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (res.ok) {
          const d = (await res.json()) as {
            name?: string;
            companyName?: string;
            workLocations?: string[];
            description?: Record<string, string>;
          };
          if (d.name) {
            return {
              title: d.name,
              company: d.companyName || ref.board,
              location: d.workLocations?.join('; ') || undefined,
              descriptionText: Object.values(d.description ?? {}).map(stripHtml).join('\n\n').slice(0, 30000),
            };
          }
        }
      } catch {
        // Fall through to the page.
      }
    }
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      return {
        title:
          clean(document.querySelector('h1')?.textContent) ||
          clean(document.title.replace(/^apply\s*-\s*/i, '')) ||
          'Unknown role',
        company: location.pathname.split('/').filter(Boolean)[0] ?? 'Unknown',
        location: undefined,
        descriptionText: clean(document.querySelector('main, body')?.textContent).slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    // The phone dial-code picker is the one dropdown with no caption at all,
    // only aria-label "Search", so it would read as a question called
    // "Search". Name it for what it asks.
    await page
      .evaluate((label) => {
        document.querySelectorAll('input[role="combobox"]:not([aria-labelledby])').forEach((el) => {
          if (el.closest('form')?.querySelector('[data-testid="input-phone_number"]')) el.setAttribute('aria-label', label);
        });
      }, PHONE_COUNTRY_LABEL)
      .catch(() => {});

    const fields = await extractFields(page);
    // Its list is virtualised - a dozen of ~240 countries are in the DOM at
    // any time - so the harvested options are a misleading sample. Left
    // free-typed, the filler types the country and picks "+91 IN - India".
    return fields.map((f) => (f.label === PHONE_COUNTRY_LABEL ? { ...f, options: undefined } : f));
  },

  fileInputs(fields) {
    // Neither file input has a name or id; the caption is "Résumé", accented,
    // and the selector is our own handle. The upload order is fixed: résumé
    // first, cover letter second.
    const files = fields.filter((f) => f.kind === 'FILE');
    return {
      resume: files.find((f) => /r[eé]sum[eé]|\bcv\b/i.test(fileHint(f))) ?? files[0],
      coverLetter: files.find((f) => /cover/i.test(fileHint(f))) ?? files[1],
    };
  },

  async submit(page) {
    const byType = page.locator('form button[type="submit"]');
    if (await byType.count()) {
      await byType.first().click();
      return;
    }
    await page.getByRole('button', { name: /^(apply|submit( application)?)$/i }).first().click();
  },

  notes: [
    'Form is opened directly at /apply?step=application.',
    'Dropdowns are labelled through aria-labelledby; some are <div> comboboxes picked by click.',
    'Location is a places autocomplete: the city is typed and the first match picked.',
  ],
  // The submit step has not been seen end to end yet.
  alwaysReview: true,
};

/** Matches the canonical location.country patterns, so it gets the profile's country. */
const PHONE_COUNTRY_LABEL = 'Country (phone dial code)';

function jobRef(url: string): { board: string; uuid: string } | null {
  try {
    const u = new URL(url);
    const m = /^\/([^/]+)\/jobs\/([0-9a-f-]{36})/i.exec(u.pathname);
    return m ? { board: decodeURIComponent(m[1]!), uuid: m[2]! } : null;
  } catch {
    return null;
  }
}

/** The posting URL, the apply URL, or anything in between, to the form itself. */
function applyUrl(url: string): string {
  const ref = jobRef(url);
  if (!ref) return url;
  const u = new URL(`https://ats.rippling.com/${encodeURIComponent(ref.board)}/jobs/${ref.uuid}/apply`);
  u.searchParams.set('jobBoardSlug', ref.board);
  u.searchParams.set('jobId', ref.uuid);
  u.searchParams.set('step', 'application');
  return u.toString();
}
