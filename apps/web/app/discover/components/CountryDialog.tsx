'use client';

import { Icon, type IconName } from '../../../components/Icon';
import { COUNTRIES, countryByCode } from '@ja/shared/countries';

/** Every action that works in one country, and how the dialog words it. */
export type CountryAction = 'find' | 'company' | 'crawl' | 'recheck';

/**
 * The dialog's "anywhere" choice: the request goes out with no country, and the
 * server keeps only jobs someone in India can take.
 */
export const WORLDWIDE = 'WORLD';

const COPY: Record<CountryAction, { sub: string; icon: IconName; verb: (country: string) => string }> = {
  find: {
    sub: 'Reads the best-paying companies for jobs in this country only. Remote roles open to it are included.',
    icon: 'sparkles',
    verb: (c) => `Search in ${c}`,
  },
  company: {
    sub: 'Finds where this company posts its openings and reads them for the roles on your profile, in this country only. Remote roles open to it are included.',
    icon: 'search',
    verb: (c) => `Search in ${c}`,
  },
  crawl: {
    sub: 'Re-reads every company on your watch list and keeps only jobs in this country.',
    icon: 'refresh',
    verb: (c) => `Search watch list in ${c}`,
  },
  recheck: {
    sub: 'Goes through the jobs waiting in "For you" and removes any outside this country, older than 3 months, too senior or too junior, or no longer open, and keeps only the newest, best-matching few from each company. Saved jobs are removed only if the posting is no longer available; applied and dismissed jobs are not touched.',
    icon: 'checkCircle',
    verb: (c) => `Clean up for ${c}`,
  },
};

const WORLDWIDE_COPY: Record<CountryAction, { sub: string; icon: IconName; verb: (country: string) => string }> = {
  find: { ...COPY.find, sub: 'Reads the best-paying companies in every country and keeps jobs you can take from India: in India, remote from anywhere or APAC, or abroad with visa sponsorship or relocation.', verb: () => 'Search worldwide' },
  company: { ...COPY.company, sub: 'Finds where this company posts its openings and reads them for the roles on your profile, keeping jobs you can take from India: in India, remote, or abroad with sponsorship or relocation.', verb: () => 'Search worldwide' },
  crawl: { ...COPY.crawl, sub: 'Re-reads every company on your watch list in every country and keeps jobs you can take from India: in India, remote from anywhere, or abroad with sponsorship or relocation.', verb: () => 'Search whole watch list' },
  recheck: {
    ...COPY.recheck,
    sub: 'Goes through the jobs waiting in "For you" and removes any you could not take from India (abroad with no remote, sponsorship or relocation), older than 3 months, too senior or too junior, or no longer open, and keeps only the newest, best-matching few from each company. Saved jobs are removed only if the posting is no longer available; applied and dismissed jobs are not touched.',
    verb: () => 'Clean up',
  },
};

export function CountryDialog({
  value,
  action,
  onChange,
  company = '',
  onCompanyChange,
  onActionChange,
  onCancel,
  onConfirm,
}: {
  value: string;
  action: CountryAction;
  onChange: (code: string) => void;
  /** The company to search, for the "company" action. */
  company?: string;
  onCompanyChange?: (name: string) => void;
  /** Lets "Find new jobs" switch between every company and one company. */
  onActionChange?: (action: CountryAction) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const worldwide = value === WORLDWIDE;
  const name = worldwide ? 'all countries' : countryByCode(value)?.name ?? 'this country';
  const copy = worldwide ? WORLDWIDE_COPY[action] : COPY[action];
  const asksCompany = action === 'company';
  const findsJobs = (action === 'find' || action === 'company') && !!onActionChange;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal discover-country"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (!asksCompany || company.trim()) onConfirm(); }}
      >
        <span className="discover-welcome-icon" aria-hidden="true"><Icon name={asksCompany ? 'search' : 'globe'} size={22} /></span>
        <h2>{findsJobs ? 'Find new jobs' : asksCompany ? 'Which company?' : 'Where should I look?'}</h2>
        {findsJobs && (
          <div className="tabs discover-scope" role="tablist" aria-label="Where to look">
            <button type="button" role="tab" aria-selected={action === 'find'} onClick={() => onActionChange('find')}>
              <Icon name="globe" size={14} /> All companies
            </button>
            <button type="button" role="tab" aria-selected={action === 'company'} onClick={() => onActionChange('company')}>
              <Icon name="search" size={14} /> One company
            </button>
          </div>
        )}
        <p className="sub">{copy.sub}</p>
        {asksCompany && (
          <label className="field">
            <span className="cap">Company name or careers link</span>
            <input
              type="text"
              value={company}
              onChange={(e) => onCompanyChange?.(e.target.value)}
              placeholder="e.g. Stripe, or https://jobs.lever.co/acme"
              autoFocus
              required
            />
          </label>
        )}
        <label className="field">
          <span className="cap">Country</span>
          <select value={value} onChange={(e) => onChange(e.target.value)} autoFocus={!asksCompany}>
            <option value={WORLDWIDE}>Anywhere (open to India)</option>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: '.5rem', marginTop: '1rem' }}>
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={asksCompany && !company.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
            <Icon name={copy.icon} size={15} />
            {copy.verb(name)}
          </button>
        </div>
      </form>
    </div>
  );
}
