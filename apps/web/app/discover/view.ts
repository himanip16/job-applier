/**
 * The list's view: which jobs, in what order, and how that is written into
 * the request and the address bar. One place, so the filter bar, the chips
 * and the request can never disagree about what "filtered" means.
 */

export type Sort = 'recommended' | 'score' | 'pay' | 'hiring' | 'posted' | 'discovered';

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
  maxYears: string;
  tier: string;
  company: string;
  /** Companies to leave out of the list. */
  notCompanies: string[];
  autoApply: boolean;
  excludeSenior: boolean;
  hiring: boolean;
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
  maxYears: '',
  tier: '',
  company: '',
  notCompanies: [],
  autoApply: false,
  excludeSenior: false,
  hiring: false,
  depth: 'any',
  limit: 25,
};

export const SORTS: { value: Sort; label: string; hint: string }[] = [
  {
    value: 'recommended',
    label: 'Recommended',
    hint: 'Match score, weighted by the median base salary people reported on LeetCode for the company (full weight at 80 LPA) and by how recently the job was posted. A company with no reports, or a job with no date, gets a neutral weight - nothing is guessed.',
  },
  { value: 'score', label: 'Best match', hint: 'Match score alone.' },
  { value: 'pay', label: 'Highest reported pay', hint: 'Median base salary reported on LeetCode for the company, then match. Companies with no reports go last.' },
  { value: 'hiring', label: 'Most hiring activity', hint: 'Interview-experience posts naming the company on LeetCode in the last 90 days.' },
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
  { value: '30', label: 'Base 30+ LPA (reported)' },
  { value: '45', label: 'Base 45+ LPA (reported)' },
  { value: '60', label: 'Base 60+ LPA (reported)' },
];

export const YEARS_OPTIONS = [
  { value: '', label: 'Any experience' },
  { value: '2', label: 'Asks ≤ 2 yrs' },
  { value: '3', label: 'Asks ≤ 3 yrs' },
  { value: '5', label: 'Asks ≤ 5 yrs' },
];

export const TIER_LABELS: Record<string, string> = {
  quant: 'Quant & trading',
  bigtech: 'Big tech',
  'infra-saas': 'Infra & SaaS',
  'india-product': 'Indian product',
  'finance-gcc': 'Finance & GCC',
  shortlist: 'Your shortlist',
  global: 'Remote or visa',
};

export const WORK_MODE_LABELS: Record<View['remote'], string> = { any: 'Any work mode', yes: 'Remote', no: 'On-site' };

/** Everything but the tab, the sort and the page size: what "Clear all" resets. */
export const FILTER_KEYS = [
  'q', 'minScore', 'postedWithin', 'country', 'city', 'remote', 'minPay', 'maxYears', 'tier', 'company', 'notCompanies', 'autoApply', 'excludeSenior', 'hiring', 'depth',
] as const satisfies readonly (keyof View)[];

export const isDefault = (view: View, key: (typeof FILTER_KEYS)[number]) => {
  const v = view[key];
  return Array.isArray(v) ? v.length === 0 : v === DEFAULT_VIEW[key];
};

export function queryString(view: View, page: number): string {
  const params = new URLSearchParams({ status: view.status, sort: view.sort, limit: String(view.limit), page: String(page) });
  for (const key of FILTER_KEYS) {
    if (isDefault(view, key)) continue;
    const v = view[key];
    // One parameter per company: names can contain commas ("Acme, Inc.").
    if (Array.isArray(v)) v.forEach((x) => params.append(key, x));
    else params.set(key, String(v));
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
  for (const k of ['q', 'minScore', 'postedWithin', 'country', 'city', 'minPay', 'maxYears', 'tier', 'company'] as const) {
    if (p.has(k)) out[k] = p.get(k)!;
  }
  if (['any', 'yes', 'no'].includes(p.get('remote') ?? '')) out.remote = p.get('remote') as View['remote'];
  if (['any', 'deep', 'quick'].includes(p.get('depth') ?? '')) out.depth = p.get('depth') as View['depth'];
  if (p.has('notCompanies')) out.notCompanies = p.getAll('notCompanies').filter(Boolean);
  if (p.has('autoApply')) out.autoApply = p.get('autoApply') === 'true';
  if (p.has('excludeSenior')) out.excludeSenior = p.get('excludeSenior') === 'true';
  if (p.has('hiring')) out.hiring = p.get('hiring') === 'true';
  const limit = Number(p.get('limit'));
  if ([10, 25, 50, 100].includes(limit)) out.limit = limit;
  return out;
}

/** The page number in the address bar; 1 when absent or malformed. The server clamps one past the end. */
export function pageFromQuery(search: string): number {
  const page = Number(new URLSearchParams(search).get('page'));
  return Number.isInteger(page) && page >= 1 ? page : 1;
}
