import type { BlockerKind } from '@ja/shared';

export interface Blocker {
  kind: BlockerKind;
  detail: string;
  /**
   * `true` when a human at the keyboard can clear it in seconds (tick a
   * checkbox, solve an image grid, click a link in their inbox). `false` means
   * the run cannot proceed at all under this design.
   */
  humanCanClear: boolean;
  /**
   * `false` for walls the run raised itself ("could not fill these fields"),
   * which detectBlockers cannot see - so "not detected" never means "dealt
   * with", and only your click carries on.
   */
  autoClears?: boolean;
  /**
   * For a wall the run raised itself: how to tell, by looking at the page,
   * that you dealt with it anyway. Polled in place of detectBlockers.
   */
  clearedWhen?: () => Promise<boolean>;
  /**
   * CAPTCHA only: a challenge is showing now. Without it the captcha is merely
   * armed - invisible reCAPTCHA sits on every Greenhouse form and usually
   * passes on submit without anyone seeing it.
   */
  onScreen?: boolean;
}
