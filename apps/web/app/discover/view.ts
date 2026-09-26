/**
 * The list's view: which jobs, in what order, and how that is written into
 * the request and the address bar. One place, so the filter bar, the chips
 * and the request can never disagree about what "filtered" means.
 */

export type Sort = 'recommended' | 'score' | 'pay' | 'posted' | 'discovered';

export interface View {
  status: string;
  sort: Sort;
  q: string;
  minScore: string;
  postedWithin: string;
  country: string;
  city: string;
  remote: 'any' | 'yes' | 'no';
  minPay: string;
  tier: string;
  company: string;
  autoApply: boolean;
  excludeSenior: boolean;
  depth: 'any' | 'deep' | 'quick';
  limit: number;
}

export const DEFAULT_VIEW: View = {
  status: 'NEW',
  sort: 'recommended',
  q: '',
  minScore: '',
  postedWithin: '',
  country: '',
  city: '',
  remote: 'any',
  minPay: '',
  tier: '',
  company: '',
  autoApply: false,
  excludeSenior: false,
  depth: 'any',
  limit: 25,
};

export const SORTS: { value: Sort; label: string; hint: string }[] = [
  {
    value: 'recommended',
    label: 'Recommended',
    hint: 'Match score, weighted by how well the company pays (up to 150 LPA) and how recently it was posted. Unknown pay or date gets a middle weight.',
  },
  { value: 'score', label: 'Best match', hint: 'Match score alone.' },
  { value: 'pay', label: 'Highest pay', hint: 'Company SDE2 pay ceiling, then match.' },
  { value: 'posted', label: 'Newest posted', hint: 'By posting date; jobs with no date go last.' },
  { value: 'discovered', label: 'Recently found', hint: 'When Job Applier found it.' },
];

export const MATCH_OPTIONS = [
  { value: '', label: 'Any match' },
  { value: '50', label: '50%+' },
  { value: '70', label: '70%+' },
  { value: '85', label: '85%+' },
];

export const POSTED_OPTIONS = [
  { value: '', label: 'Any time' },
  { value: '7', label: 'Past week' },
  { value: '30', label: 'Past month' },
  { value: '90', label: 'Past 3 months' },
];

export const PAY_OPTIONS = [
  { value: '', label: 'Any pay' },
  { value: '80', label: '80+ LPA' },
  { value: '100', label: '100+ LPA' },
  { value: '150', label: '150+ LPA' },
];

export const TIER_LABELS: Record<string, string> = {
  quant: 'Quant & trading',
  bigtech: 'Big tech',
  'infra-saas': 'Infra & SaaS',
  'india-product': 'Indian product',
  'finance-gcc': 'Finance & GCC',
};

export const WORK_MODE_LABELS: Record<View['remote'], string> = { any: 'Any work mode', yes: 'Remote', no: 'On-site' };

/** Everything but the tab, the sort and the page size: what "Clear all" resets. */
export const FILTER_KEYS = [
  'q', 'minScore', 'postedWithin', 'country', 'city', 'remote', 'minPay', 'tier', 'company', 'autoApply', 'excludeSenior', 'depth',
] as const satisfies readonly (keyof View)[];

export const isDefault = (view: View, key: (typeof FILTER_KEYS)[number]) => view[key] === DEFAULT_VIEW[key];

export function queryString(view: View, page: number): string {
  const params = new URLSearchParams({ status: view.status, sort: view.sort, limit: String(view.limit), page: String(page) });
  for (const key of FILTER_KEYS) {
    if (!isDefault(view, key)) params.set(key, String(view[key]));
  }
  return params.toString();
}

/** Read a view back out of the address bar, ignoring anything malformed. */
export function viewFromQuery(search: string): Partial<View> {
  const p = new URLSearchParams(search);
  const out: Partial<View> = {};
  const str = (k: keyof View) => p.get(k) ?? undefined;
  if (str('status')) out.status = str('status')!;
  if (SORTS.some((s) => s.value === p.get('sort'))) out.sort = p.get('sort') as Sort;
  for (const k of ['q', 'minScore', 'postedWithin', 'country', 'city', 'minPay', 'tier', 'company'] as const) {
    if (p.has(k)) out[k] = p.get(k)!;
  }
  if (['any', 'yes', 'no'].includes(p.get('remote') ?? '')) out.remote = p.get('remote') as View['remote'];
  if (['any', 'deep', 'quick'].includes(p.get('depth') ?? '')) out.depth = p.get('depth') as View['depth'];
  if (p.has('autoApply')) out.autoApply = p.get('autoApply') === 'true';
  if (p.has('excludeSenior')) out.excludeSenior = p.get('excludeSenior') === 'true';
  const limit = Number(p.get('limit'));
  if ([10, 25, 50, 100].includes(limit)) out.limit = limit;
  return out;
}
