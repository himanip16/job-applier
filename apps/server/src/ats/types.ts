import type { Page } from 'playwright';
import type { FormField } from '@ja/shared';

export interface JobMeta {
  company: string;
  title: string;
  location?: string;
  descriptionText: string;
}

export interface AtsAdapter {
  /** Stable identifier stored on the Job row. */
  id: string;
  /** Cheap URL test, run before any network access. */
  matches(url: string): boolean;
  /**
   * Navigate to the page that actually contains the application form.
   * Lever splits posting and form across two URLs; Greenhouse does not.
   */
  openApplicationForm(page: Page, url: string): Promise<void>;
  /** Read title/company/JD text for the cover letter. */
  readJobMeta(page: Page): Promise<JobMeta>;
  /** Describe every control on the form. */
  extractForm(page: Page): Promise<FormField[]>;
  /** Point at the resume and (optional) cover-letter file inputs. */
  fileInputs(fields: FormField[]): { resume?: FormField; coverLetter?: FormField };
  /** Click the real submit control. */
  submit(page: Page): Promise<void>;
  /** Optional custom file attachment logic for sites with non-standard upload flows. */
  attachFile?(page: Page, field: FormField, filePath: string): Promise<void>;
  /** Human-readable notes shown in the UI: known quirks, captcha, etc. */
  notes: string[];
}

export async function textOf(page: Page, selector: string): Promise<string> {
  const el = page.locator(selector).first();
  if (!(await el.count())) return '';
  return (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
}
