'use client';

import { Icon, type IconName } from '../../../components/Icon';
import { COUNTRIES, countryByCode } from '@ja/shared/countries';

/** Every action that works in one country, and how the dialog words it. */
export type CountryAction = 'find' | 'preview' | 'crawl' | 'recheck';

const COPY: Record<CountryAction, { sub: string; icon: IconName; verb: (country: string) => string }> = {
  find: {
    sub: 'Reads the best-paying companies for jobs in this country only. Remote roles open to it are included.',
    icon: 'sparkles',
    verb: (c) => `Search in ${c}`,
  },
  preview: {
    sub: 'Shows the roles and companies it would search, without reading anything.',
    icon: 'eye',
    verb: (c) => `Preview for ${c}`,
  },
  crawl: {
    sub: 'Re-reads every company on your watch list and keeps only jobs in this country.',
    icon: 'refresh',
    verb: (c) => `Re-check boards for ${c}`,
  },
  recheck: {
    sub: 'Goes through the jobs waiting in "For you" and removes any outside this country, older than 3 months, too senior, or no longer open. Saved, applied and dismissed jobs are not touched.',
    icon: 'checkCircle',
    verb: (c) => `Re-check jobs for ${c}`,
  },
};

export function CountryDialog({
  value,
  action,
  onChange,
  onCancel,
  onConfirm,
}: {
  value: string;
  action: CountryAction;
  onChange: (code: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const name = countryByCode(value)?.name ?? 'this country';
  const copy = COPY[action];
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal discover-country"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onConfirm(); }}
      >
        <span className="discover-welcome-icon" aria-hidden="true"><Icon name="globe" size={22} /></span>
        <h2>Where should I look?</h2>
        <p className="sub">{copy.sub}</p>
        <label className="field">
          <span className="cap">Country</span>
          <select value={value} onChange={(e) => onChange(e.target.value)} autoFocus>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: '.5rem', marginTop: '1rem' }}>
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
            <Icon name={copy.icon} size={15} />
            {copy.verb(name)}
          </button>
        </div>
      </form>
    </div>
  );
}
