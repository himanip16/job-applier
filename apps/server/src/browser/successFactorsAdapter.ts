import type { Page } from 'playwright';
import type { SiteAccount, AccountAttempt } from './accountWall';
import { fillBox, siteError, tick, click } from './domHelpers';

/**
 * The rest of SuccessFactors' standalone Create Account (Nomura): phone code,
 * mobile, country of residence, who may see the profile, and the data privacy
 * statement. Without them it refuses the whole form ("The following fields
 * require a valid input: Country/Region Code, Mobile Phone, ...").
 *
 * Visibility gets the narrower choice, "Only recruiters managing jobs I apply
 * to". The privacy statement is a dialog that sets the hidden fbclc_dpcsId
 * once accepted, and it is per country, so the country goes in first.
 * A form without these boxes is left alone.
 */
export async function fillSuccessFactorsExtras(page: Page, account: SiteAccount): Promise<AccountAttempt> {
  const visible = (sel: string) => page.locator(sel).first().isVisible().catch(() => false);
  const country = account.countryCode?.toUpperCase();
  const pick = async (sel: string): Promise<boolean> => {
    if (!(await visible(sel))) return true;
    if (await page.locator(sel).first().inputValue().catch(() => '')) return true;
    if (!country) return false;
    const done = await page.locator(sel).first().selectOption(country, { timeout: 3000 }).catch(() => []);
    await page.locator(sel).first().dispatchEvent('blur').catch(() => {});
    return done.length > 0;
  };
  const missing: string[] = [];
  if (!(await pick('select[name="fbclc_ituCode"]'))) missing.push('Country/Region Code');
  if (await visible('input[name="fbclc_phoneNumber"]')) {
    if (account.phone) await fillBox(page, 'input[name="fbclc_phoneNumber"]', /^\s*mobile phone/i, account.phone);
    if (!(await page.locator('input[name="fbclc_phoneNumber"]').first().inputValue().catch(() => ''))) {
      missing.push('Mobile Phone');
    }
  }
  if (!(await pick('select[name="fbclc_country"]'))) missing.push('Country/Region of Residence');
  if (missing.length) {
    return { ok: false, detail: `The Create Account form needs ${missing.join(', ')}, which your profile does not have.` };
  }

  const radios = page.locator('input[name="fbclc_searPref"]');
  if ((await radios.count().catch(() => 0)) && !(await page.locator('input[name="fbclc_searPref"]:checked').count())) {
    const narrow = page.locator('input[name="fbclc_searPref"][value="2"]').first();
    if (!(await tick(page, (await narrow.count()) ? narrow : radios.last()))) {
      return { ok: false, detail: 'Could not set "Make My Profile Visible to" on the Create Account form.' };
    }
  }

  const dpcs = page.locator('#fbclc_dpcsId');
  if ((await dpcs.count().catch(() => 0)) && !(await dpcs.inputValue().catch(() => ''))) {
    await page.locator('#dataPrivacyId').first().click({ timeout: 5000 }).catch(() => {});
    const accept = page.getByRole('button', { name: /^\s*(accept|i agree|accept and continue)\s*$/i });
    await accept.first().waitFor({ timeout: 15_000 }).catch(() => {});
    // The Accept button can stay disabled until the statement is scrolled through.
    await page
      .evaluate(() => {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] *, .sfDialogBox *'))) {
          if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight;
        }
      })
      .catch(() => {});
    const n = await accept.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = accept.nth(i);
      if ((await b.isVisible().catch(() => false)) && (await click(b))) break;
    }
    await page
      .waitForFunction(() => !!(document.querySelector('#fbclc_dpcsId') as HTMLInputElement | null)?.value, null, {
        timeout: 10_000,
      })
      .catch(() => {});
    if (!(await dpcs.inputValue().catch(() => ''))) {
      return { ok: false, detail: 'Filled the Create Account form but could not accept its data privacy statement.' };
    }
  }
  return { ok: true, detail: '' };
}
