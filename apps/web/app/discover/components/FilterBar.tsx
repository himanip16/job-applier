'use client';

import { CITIES, COUNTRIES, countryByCode } from '@ja/shared/countries';
import { Icon } from '../../../components/Icon';
import type { LeadPage } from '../types';
import {
  DEFAULT_VIEW,
  FILTER_KEYS,
  isDefault,
  MATCH_OPTIONS,
  PAY_OPTIONS,
  POSTED_OPTIONS,
  SORTS,
  TIER_LABELS,
  WORK_MODE_LABELS,
  type View,
} from '../view';
import styles from '../discover.module.css';

interface Option {
  value: string;
  label: string;
}

/**
 * Every way to narrow the list, in one card.
 *
 * Search on top, one row of filters under it, and underneath those a line
 * that says exactly what is applied - each as a chip you can remove - and how
 * many jobs that leaves. Nothing hides behind a disclosure you forget is open.
 */
export function FilterBar({
  view,
  typed,
  facets,
  total,
  onTyped,
  onChange,
}: {
  view: View;
  typed: string;
  facets: LeadPage['facets'];
  total: number;
  onTyped: (v: string) => void;
  onChange: (patch: Partial<View>) => void;
}) {
  const cities = facets.cities.filter((c) => !view.country || CITIES.find((x) => x.name === c.name)?.country === view.country);
  const withCount = (f: { name: string; count: number }, label = f.name): Option => ({ value: f.name, label: `${label} (${f.count})` });
  const sort = SORTS.find((s) => s.value === view.sort) ?? SORTS[0]!;

  return (
    <section className={styles.filterCard} aria-label="Search and filter jobs">
      <div className={styles.searchRow}>
        <label className={styles.search}>
          <Icon name="search" size={17} />
          <span className="sr-only">Search jobs</span>
          <input
            type="search"
            value={typed}
            placeholder="Search role, company, city or skill — e.g. backend, Stripe, Kafka"
            onChange={(e) => onTyped(e.target.value)}
          />
          {typed && (
            <button type="button" className={styles.searchClear} onClick={() => onChange({ q: '' })} aria-label="Clear search">
              <Icon name="x" size={14} />
            </button>
          )}
        </label>
        <label className={styles.sort} title={sort.hint}>
          <Icon name="sort" size={15} />
          <span className={styles.sortCap}>Sort</span>
          <select value={view.sort} onChange={(e) => onChange({ sort: e.target.value as View['sort'] })}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.filterRow} role="group" aria-label="Filters">
        <Pill label="Match" value={view.minScore} options={MATCH_OPTIONS} onChange={(minScore) => onChange({ minScore })} />
        <Pill label="Posted" value={view.postedWithin} options={POSTED_OPTIONS} onChange={(postedWithin) => onChange({ postedWithin })} />
        <Pill label="Pay" value={view.minPay} options={PAY_OPTIONS} onChange={(minPay) => onChange({ minPay })} />
        <Pill
          label="Company type"
          value={view.tier}
          options={[{ value: '', label: 'Any type' }, ...facets.tiers.map((t) => withCount(t, TIER_LABELS[t.name] ?? t.name))]}
          onChange={(tier) => onChange({ tier })}
        />
        <Pill
          label="Country"
          value={view.country}
          options={[{ value: '', label: 'Any country' }, ...COUNTRIES.map((c) => ({ value: c.code, label: c.name }))]}
          onChange={(country) => onChange({ country, city: '' })}
        />
        <Pill
          label="City"
          value={view.city}
          options={[{ value: '', label: 'Any city' }, ...cities.map((c) => withCount(c))]}
          onChange={(city) => onChange({ city })}
        />
        <Pill
          label="Work mode"
          value={view.remote}
          options={Object.entries(WORK_MODE_LABELS).map(([value, label]) => ({ value, label }))}
          onChange={(remote) => onChange({ remote: remote as View['remote'] })}
        />
        <Pill
          label="Company"
          value={view.company}
          options={[{ value: '', label: 'Any company' }, ...facets.companies.map((c) => withCount(c))]}
          onChange={(company) => onChange({ company })}
        />
        <Toggle
          label="Auto-apply only"
          hint="Only Greenhouse, Lever, Ashby and Workable jobs, whose forms the app can fill in by itself."
          on={view.autoApply}
          onChange={(autoApply) => onChange({ autoApply })}
        />
        <Toggle
          label="Hide senior roles"
          hint="Leave out Staff, Principal, Manager and above, and roles asking for 6+ years."
          on={view.excludeSenior}
          onChange={(excludeSenior) => onChange({ excludeSenior })}
        />
        <Pill
          label="Scored by"
          value={view.depth}
          options={[
            { value: 'any', label: 'Any scoring' },
            { value: 'deep', label: 'Read by AI' },
            { value: 'quick', label: 'Keywords only' },
          ]}
          onChange={(depth) => onChange({ depth: depth as View['depth'] })}
        />
      </div>

      <ActiveFilters view={view} total={total} sortLabel={sort.label} onChange={onChange} />
    </section>
  );
}

/** A select that looks like a pill, and says so when it is doing something. */
function Pill({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  const active = value !== options[0]?.value;
  return (
    <label className={`${styles.pill} ${active ? styles.pillOn : ''}`}>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.value === options[0]?.value ? label : o.label}</option>
        ))}
      </select>
      <Icon name="chevron" size={13} />
    </label>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`${styles.pill} ${on ? styles.pillOn : ''}`} aria-pressed={on} title={hint} onClick={() => onChange(!on)}>
      {on && <Icon name="check" size={13} />} {label}
    </button>
  );
}

/** What is applied, in words, each removable on its own. */
function ActiveFilters({
  view,
  total,
  sortLabel,
  onChange,
}: {
  view: View;
  total: number;
  sortLabel: string;
  onChange: (patch: Partial<View>) => void;
}) {
  const labelOf = (options: Option[], value: string) => options.find((o) => o.value === value)?.label ?? value;
  const describe: Record<(typeof FILTER_KEYS)[number], () => string> = {
    q: () => `“${view.q}”`,
    minScore: () => `${view.minScore}%+ match`,
    postedWithin: () => labelOf(POSTED_OPTIONS, view.postedWithin),
    country: () => countryByCode(view.country)?.name ?? view.country,
    city: () => view.city,
    remote: () => WORK_MODE_LABELS[view.remote],
    minPay: () => labelOf(PAY_OPTIONS, view.minPay),
    tier: () => TIER_LABELS[view.tier] ?? view.tier,
    company: () => view.company,
    autoApply: () => 'Auto-apply only',
    excludeSenior: () => 'No senior roles',
    depth: () => (view.depth === 'deep' ? 'Read by AI' : 'Keywords only'),
  };
  const active = FILTER_KEYS.filter((k) => !isDefault(view, k));
  const reset = (keys: readonly (typeof FILTER_KEYS)[number][]) =>
    onChange(Object.fromEntries(keys.map((k) => [k, DEFAULT_VIEW[k]])) as Partial<View>);

  return (
    <div className={styles.summary}>
      <span className={styles.count}>
        <strong>{total.toLocaleString()}</strong> job{total === 1 ? '' : 's'} · {sortLabel}
      </span>
      {active.map((k) => (
        <button key={k} type="button" className={styles.chip} onClick={() => reset([k])} title="Remove this filter">
          {describe[k]()} <Icon name="x" size={12} />
        </button>
      ))}
      {active.length > 1 && (
        <button type="button" className={styles.clearAll} onClick={() => reset(FILTER_KEYS)}>
          Clear all
        </button>
      )}
    </div>
  );
}
