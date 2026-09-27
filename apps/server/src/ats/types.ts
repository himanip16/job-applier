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
  /** Human-readable notes shown in the UI: known quirks, captcha, etc. */
  notes: string[];
  /**
   * Always stop for review before submitting, whatever the settings say. For
   * sites whose final step has not been seen in a real run yet.
   */
  alwaysReview?: boolean;
}

export async function textOf(page: Page, selector: string): Promise<string> {
  const el = page.locator(selector).first();
  if (!(await el.count())) return '';
  return (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
}

/**
 * What a file input is for, from everything that might say so.
 *
 * Greenhouse labels both of its upload inputs "Attach"; only the id says
 * `resume` or `cover_letter`. Matching on the label alone found neither, and
 * applications went out with no resume.
 */
export function fileHint(f: Pick<FormField, 'label' | 'name' | 'selector'>): string {
  return `${f.label} ${f.name ?? ''} ${f.selector}`;
}
