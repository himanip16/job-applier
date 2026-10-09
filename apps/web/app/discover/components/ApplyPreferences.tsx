'use client';

import { useEffect, useState } from 'react';
import { Icon } from '../../../components/Icon';
import styles from '../discover.module.css';

export interface ApplyPrefs {
  tailorResume: boolean;
  writeCoverLetter: boolean;
}

const KEYS = { tailorResume: 'ja.tailorResume', writeCoverLetter: 'ja.coverLetter' } as const;

/**
 * What Apply does, remembered in this browser.
 *
 * Tailoring is on by default, as it always was; the cover letter is off,
 * because most forms do not need one and writing one costs a model call and
 * half a minute. A form that requires a cover letter gets one regardless.
 */
export function useApplyPrefs(): [ApplyPrefs, (patch: Partial<ApplyPrefs>) => void] {
  const [prefs, setPrefs] = useState<ApplyPrefs>({ tailorResume: true, writeCoverLetter: false });
  useEffect(() => {
    try {
      setPrefs({
        tailorResume: window.localStorage.getItem(KEYS.tailorResume) !== 'off',
        writeCoverLetter: window.localStorage.getItem(KEYS.writeCoverLetter) === 'on',
      });
    } catch {
      // Private windows and blocked site data both throw here; the defaults stand.
    }
  }, []);
  const update = (patch: Partial<ApplyPrefs>) => {
    setPrefs((p) => ({ ...p, ...patch }));
    for (const [k, v] of Object.entries(patch) as [keyof ApplyPrefs, boolean][]) {
      try {
        window.localStorage.setItem(KEYS[k], v ? 'on' : 'off');
      } catch {
        // Not being able to remember it is not a reason to refuse the change.
      }
    }
  };
  return [prefs, update];
}

/** The settings behind Apply, tucked into one menu next to the list. */
export function ApplyPreferences({ prefs, onChange }: { prefs: ApplyPrefs; onChange: (patch: Partial<ApplyPrefs>) => void }) {
  const on = [prefs.tailorResume && 'tailored resume', prefs.writeCoverLetter && 'cover letter'].filter(Boolean);
  return (
    <details className={styles.menu}>
      <summary title="What happens when you press Apply">
        <Icon name="sliders" size={14} /> Apply with: {on.length ? on.join(' + ') : 'resume as is'}
      </summary>
      <div className={`${styles.menuBody} ${styles.prefs}`}>
        <label>
          <input type="checkbox" checked={prefs.tailorResume} onChange={(e) => onChange({ tailorResume: e.target.checked })} />
          <span>
            <strong>Tailor my resume to the job</strong>
            <span className={styles.menuHint}>Adds the job’s keywords your experience supports. One AI call.</span>
          </span>
        </label>
        <label>
          <input type="checkbox" checked={prefs.writeCoverLetter} onChange={(e) => onChange({ writeCoverLetter: e.target.checked })} />
          <span>
            <strong>Write a cover letter</strong>
            <span className={styles.menuHint}>A form that requires one gets one either way.</span>
          </span>
        </label>
      </div>
    </details>
  );
}
