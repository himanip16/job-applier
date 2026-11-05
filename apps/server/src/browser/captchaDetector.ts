import type { Page } from 'playwright';
import type { Blocker } from './blockerTypes.js';
import { evaluatePage } from './evaluate.js';

export interface CaptchaDetection {
  hits: string[];
  challengeVisible: boolean;
}

/**
 * Detect CAPTCHA challenges on the page.
 */
export async function detectCaptcha(page: Page): Promise<Blocker | null> {
  const captcha = await evaluatePage(page, () => {
    const hits: string[] = [];
    const q = (sel: string) => document.querySelector(sel);

    // Rendered widgets. An invisible reCAPTCHA also injects these, so their
    // presence alone is not proof a challenge will be shown - see `visible`.
    if (q('.g-recaptcha, #g-recaptcha, iframe[src*="recaptcha"]')) hits.push('recaptcha');
    if (q('.h-captcha, iframe[src*="hcaptcha"]')) hits.push('hcaptcha');
    if (q('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]')) hits.push('turnstile');
    if (q('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]')) hits.push('arkose');

    // Is a challenge actually on screen right now, versus armed but silent?
    const challengeVisible = Array.from(
      document.querySelectorAll<HTMLIFrameElement>(
        'iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com/captcha"], .cf-turnstile iframe',
      ),
    ).some((f) => {
      const r = f.getBoundingClientRect();
      return r.width > 40 && r.height > 40 && getComputedStyle(f).visibility !== 'hidden';
    });

    return { hits, challengeVisible };
  });

  if (captcha.hits.length) {
    return {
      kind: 'CAPTCHA',
      detail: captcha.challengeVisible
        ? `A ${captcha.hits.join('/')} challenge is on screen and must be solved by a person.`
        : `${captcha.hits.join('/')} is armed on this form. It may pass silently, or it may challenge on submit.`,
      humanCanClear: true,
      onScreen: captcha.challengeVisible,
    };
  }

  return null;
}
