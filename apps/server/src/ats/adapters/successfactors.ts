import type { Page } from 'playwright';
import { fileHint } from '../types.js';
import type { AtsAdapter, JobMeta } from '../types.js';
import { extractFields } from '../../browser/extract.js';
import { matchCanonical } from '@ja/shared';

/**
 * SAP SuccessFactors career sites (Recruiting Marketing).
 *
 * Used by Nomura, Deutsche Bank, and many other banks/enterprises.
 * Key characteristics:
 * - Uses SAP UI5 components (ui5-input, ui5-select, ui5-responsive-popover)
 * - Value-help dropdowns require exact matches against internal lookup IDs
 * - Multi-step wizard with dynamic "Job-Specific Information" fields
 * - Step 3 contains employer-defined requisition questions (notice period, DE&I, etc.)
 */

/**
 * SuccessFactors URL patterns:
 * - careers.<company>.com
 * - <company>.successfactors.eu
 * - <company>.successfactors.com
 */
const SUCCESSFACTORS_DOMAINS = /(\.successfactors\.(com|eu)|careers\.[a-z0-9-]+\.com)/i;

/**
 * Custom field label mappings for SuccessFactors-specific questions.
 * These handle Step 3 "Job-Specific Information" fields that may not match
 * canonical patterns exactly.
 */
const SUCCESSFACTORS_FIELD_MAPPINGS: Record<string, string> = {
  // Notice period variations
  'notice period (in weeks)': 'availability.notice_period',
  'notice period (weeks)': 'availability.notice_period',
  'notice period': 'availability.notice_period',
  'how much notice do you need': 'availability.notice_period',
  'notice period in days': 'availability.notice_period',
  'notice period in months': 'availability.notice_period',

  // Prior employment variations
  'have you worked for us before': 'history.worked_here_before',
  'previous employment with': 'history.worked_here_before',
  'former employee': 'history.worked_here_before',
  'have you been employed by': 'history.worked_here_before',

  // Referral variations
  'referred by': 'history.referral',
  'who referred you': 'history.referral',
  'referral source': 'history.referral',

  // Source variations
  'how did you hear about this position': 'history.source',
  'how did you hear about us': 'history.source',
  'source of application': 'history.source',

  // Relocation variations
  'are you willing to relocate': 'logistics.relocate',
  'relocation willingness': 'logistics.relocate',
  'open to relocation': 'logistics.relocate',

  // Salary expectations variations
  'expected ctc': 'compensation.expectation',
  'expected salary': 'compensation.expectation',
  'salary expectations': 'compensation.expectation',
  'expected compensation': 'compensation.expectation',
};

/**
 * Unit conversion helpers for notice period fields.
 * SuccessFactors sometimes asks for notice period in days or months,
 * but we store it internally as weeks.
 */
function normalizeNoticePeriod(value: string, unit?: string): string {
  const num = parseInt(value, 10);
  if (isNaN(num)) return value;

  const lowerUnit = (unit || '').toLowerCase();

  // Days to weeks
  if (/day/.test(lowerUnit)) {
    return Math.round(num / 7).toString();
  }

  // Months to weeks (approximate: 1 month = 4 weeks)
  if (/month/.test(lowerUnit)) {
    return (num * 4).toString();
  }

  // Already in weeks
  return value;
}

/**
 * Detect if a field label contains a unit hint (days, months, weeks).
 */
function extractUnitFromLabel(label: string): string | undefined {
  const match = label.match(/\b(days?|weeks?|months?)\b/i);
  return match ? match[1] : undefined;
}

/**
 * Custom field label resolver for SuccessFactors.
 * First checks SuccessFactors-specific mappings, then falls back to canonical matching.
 */
function resolveSuccessFactorsField(label: string): string | undefined {
  const normalized = label.trim().toLowerCase();

  // Check custom mappings first
  for (const [pattern, canonicalKey] of Object.entries(SUCCESSFACTORS_FIELD_MAPPINGS)) {
    if (normalized === pattern.toLowerCase() || normalized.includes(pattern.toLowerCase())) {
      return canonicalKey;
    }
  }

  // Fall back to canonical matching
  const canonical = matchCanonical(label);
  return canonical?.key;
}

export const successFactorsAdapter: AtsAdapter = {
  id: 'successfactors',

  matches(url) {
    return SUCCESSFACTORS_DOMAINS.test(url);
  },

  async openApplicationForm(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // SuccessFactors may show a cookie banner or initial loading state
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  },

  async readJobMeta(page): Promise<JobMeta> {
    return page.evaluate(() => {
      const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const text = (sel: string) => clean(document.querySelector(sel)?.textContent);

      // SuccessFactors job pages vary in structure
      const title =
        text('[data-test-id="job-title"]') ||
        text('h1.job-title') ||
        text('h1') ||
        clean(document.title);

      const company =
        text('[data-test-id="company-name"]') ||
        text('.company-name') ||
        clean(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')) ||
        window.location.hostname.split('.')[0] ||
        'Unknown';

      const location =
        text('[data-test-id="location"]') ||
        text('.job-location') ||
        text('.location') ||
        undefined;

      const description =
        text('[data-test-id="job-description"]') ||
        text('.job-description') ||
        text('#job-description') ||
        text('main') ||
        '';

      return {
        title,
        company,
        location,
        descriptionText: description.slice(0, 30000),
      };
    });
  },

  async extractForm(page) {
    const fields = await extractFields(page, { harvestComboboxOptions: true });

    // Apply SuccessFactors-specific field label mapping
    return fields.map((field) => {
      const customKey = resolveSuccessFactorsField(field.label);
      if (customKey) {
        return { ...field, canonicalKey: customKey };
      }
      return field;
    });
  },

  fileInputs(fields) {
    const files = fields.filter((f) => f.kind === 'FILE');
    return {
      resume: files.find((f) => /resume|cv/i.test(fileHint(f))) ?? files[0],
      coverLetter: files.find((f) => /cover/i.test(fileHint(f))),
    };
  },

  async submit(page) {
    // SuccessFactors submit button typically has a specific data attribute or class
    const submitSelectors = [
      '[data-test-id="submit-application"]',
      'button[type="submit"]',
      '.submit-button',
      '#submit-application',
    ];

    for (const selector of submitSelectors) {
      const button = page.locator(selector).first();
      if (await button.count()) {
        await button.click();
        return;
      }
    }

    // Fallback to generic submit
    await page.locator('form button[type="submit"], form input[type="submit"]').first().click();
  },

  notes: [
    'Uses SAP UI5 components with value-help dropdowns that require exact matches.',
    'Step 3 contains dynamic job-specific questions (notice period, DE&I surveys).',
    'Option normalization handles city/state/currency variants (Bangalore → Bengaluru, Karnataka → KA).',
    'Multi-column PDF detection helps avoid text truncation issues.',
    'Custom field mappings handle SuccessFactors-specific label variations.',
  ],
};
