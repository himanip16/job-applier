import type { FormField } from '@ja/shared';
import type { Resolution } from './resolver.js';

/**
 * Salary answers in the currency the form asks for.
 *
 * The candidate saves one expectation ("45 LPA"); forms ask for it in rupees,
 * dollars, euros, as a plain number, in lakhs, per month. Typing "45 LPA" into
 * "Expected salary (USD)" is wrong, and so is typing 4500000 there. This works
 * out which currency the form wants, converts at today's published rate and
 * says which rate it used. When the rate cannot be fetched the field becomes a
 * question for the human rather than an unconverted number.
 */

export interface Money {
  currency: string | null;
  min: number;
  max: number;
  period: 'year' | 'month';
}

/** Ordered: "US$", "S$", "C$" must be read before a bare "$". */
const CURRENCIES: [RegExp, string][] = [
  [/₹|\binr\b|\brs\.?(?=\s|\d)|\brupees?\b|\blpa\b|\blakhs?\b|\blacs?\b|\bcrores?\b/gi, 'INR'],
  [/\busd\b|\bus\s?\$|\bu\.s\.\s*dollars?\b|\bus dollars?\b/gi, 'USD'],
  [/\bsgd\b|\bs\$/gi, 'SGD'],
  [/\bcad\b|\bc\$|\bca\$/gi, 'CAD'],
  [/\baud\b|\ba\$|\bau\$/gi, 'AUD'],
  [/\bnzd\b|\bnz\$/gi, 'NZD'],
  [/\bhkd\b|\bhk\$/gi, 'HKD'],
  [/\beur\b|€|\beuros?\b/gi, 'EUR'],
  [/\bgbp\b|£|\bpounds? sterling\b/gi, 'GBP'],
  [/\baed\b|\bdirhams?\b/gi, 'AED'],
  [/\bjpy\b|¥|\byen\b/gi, 'JPY'],
  [/\bchf\b/gi, 'CHF'],
  [/\bpln\b|zł/gi, 'PLN'],
  [/\bsek\b/gi, 'SEK'],
  [/\$/g, 'USD'],
];

/** Every currency a piece of text names. */
export function currenciesIn(text: string): Set<string> {
  const found = new Set<string>();
  let rest = text;
  for (const [re, code] of CURRENCIES) {
    if (rest.match(re)) {
      found.add(code);
      rest = rest.replace(re, ' ');
    }
  }
  return found;
}

function soleCurrency(text: string): string | null {
  const found = currenciesIn(text);
  return found.size === 1 ? [...found][0]! : null;
}

const UNIT = String.raw`(lpa|lakhs?|lacs?|l\b|crores?|cr\b|k\b|mn\b|m\b|million)`;
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)\s*${UNIT}?`;

function multiplier(unit: string | undefined): number {
  const u = (unit ?? '').toLowerCase();
  if (/^(lpa|lakhs?|lacs?|l)$/.test(u)) return 1e5;
  if (/^(crores?|cr)$/.test(u)) return 1e7;
  if (u === 'k') return 1e3;
  if (/^(m|mn|million)$/.test(u)) return 1e6;
  return 1;
}

const MONTHLY = /per\s*month|monthly|\/\s*mo(nth)?\b|\bp\.?\s?m\.?(?=\s|$|\))/i;

/**
 * "45 LPA", "₹40-45 lakhs", "$120k - $140k", "23,00,000", "USD 9,000 per month".
 * Null for "Open to discussion" and anything else without an amount.
 */
export function parseMoney(text: string, fallbackCurrency: string | null = null): Money | null {
  const range = text.match(new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*[^\\d]{0,4}${NUM}`, 'i'));
  let lo: number;
  let hi: number;
  if (range) {
    // "40-45 LPA": the unit written once applies to both ends.
    const loUnit = range[2] ?? range[4];
    const hiUnit = range[4] ?? range[2];
    lo = Number(range[1]!.replace(/,/g, '')) * multiplier(loUnit);
    hi = Number(range[3]!.replace(/,/g, '')) * multiplier(hiUnit);
    // "45 LPA - 10% variable" is not a range.
    if (hi < lo) hi = lo;
  } else {
    const one = text.match(new RegExp(NUM, 'i'));
    if (!one) return null;
    lo = hi = Number(one[1]!.replace(/,/g, '')) * multiplier(one[2]);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) return null;
  return {
    currency: soleCurrency(text) ?? fallbackCurrency,
    min: lo,
    max: hi,
    period: MONTHLY.test(text) && !/\blpa\b|per\s*annum|annual|yearly|per\s*year/i.test(text) ? 'month' : 'year',
  };
}

const COUNTRY_CURRENCY: Record<string, string> = {
  india: 'INR', in: 'INR', 'united states': 'USD', usa: 'USD', us: 'USD', 'united kingdom': 'GBP', uk: 'GBP', gb: 'GBP',
  singapore: 'SGD', sg: 'SGD', canada: 'CAD', ca: 'CAD', australia: 'AUD', au: 'AUD', 'united arab emirates': 'AED',
  uae: 'AED', ae: 'AED', germany: 'EUR', de: 'EUR', ireland: 'EUR', ie: 'EUR', netherlands: 'EUR', nl: 'EUR',
  france: 'EUR', fr: 'EUR', spain: 'EUR', es: 'EUR', japan: 'JPY', jp: 'JPY', switzerland: 'CHF', ch: 'CHF',
};

export function currencyOfCountry(country?: string | null): string | null {
  return country ? (COUNTRY_CURRENCY[country.trim().toLowerCase()] ?? null) : null;
}

// ------------------------------------------------------------------- rates ---

interface Rates { base: string; rates: Record<string, number>; asOf: string; fetchedAt: number }
const rateCache = new Map<string, Rates>();
const RATE_TTL = 6 * 60 * 60_000;
const RATE_SOURCE = 'open.er-api.com';

/** Today's published rate from one currency to another. Throws when it cannot be had. */
export async function exchangeRate(from: string, to: string): Promise<{ rate: number; asOf: string }> {
  if (from === to) return { rate: 1, asOf: 'n/a' };
  let cached = rateCache.get(from);
  if (!cached || Date.now() - cached.fetchedAt > RATE_TTL) {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${RATE_SOURCE} answered ${res.status}`);
    const body = (await res.json()) as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
    if (body.result !== 'success' || !body.rates) throw new Error(`${RATE_SOURCE} returned no rates for ${from}`);
    cached = { base: from, rates: body.rates, asOf: body.time_last_update_utc ?? new Date().toUTCString(), fetchedAt: Date.now() };
    rateCache.set(from, cached);
  }
  const rate = cached.rates[to];
  if (!rate) throw new Error(`${RATE_SOURCE} has no ${from}→${to} rate`);
  return { rate, asOf: cached.asOf };
}

// ------------------------------------------------------------- the target ---

interface Target {
  currency: string | null;
  why: string;
  /** The form wants the figure in lakhs / thousands rather than units. */
  scale: 1 | 1e3 | 1e5;
  period: 'year' | 'month' | null;
}

const CURRENCY_FIELD = /currency/i;

function targetFor(
  field: FormField,
  fields: FormField[],
  out: Map<string, Resolution>,
  jobDescription: string,
): Target {
  const text = `${field.label} ${field.helpText ?? ''}`;
  const scale = /\blpa\b|lakhs?|lacs?/i.test(text) ? 1e5 : /in\s*thousands|\(\s*k\s*\)|'000s?/i.test(text) ? 1e3 : 1;
  const period = MONTHLY.test(text) ? 'month' : /annual|per\s*annum|per\s*year|yearly|\blpa\b|\bctc\b/i.test(text) ? 'year' : null;

  // 1. The question names it: "Expected salary (USD)", "Expected CTC in ₹ lakhs".
  const named = soleCurrency(text);
  if (named) return { currency: named, why: 'the question asks for it', scale, period };

  // 2. A currency field beside it on the same page, already answered.
  const picked = new Set<string>();
  for (const f of fields) {
    if (f.id === field.id || !CURRENCY_FIELD.test(f.label)) continue;
    const res = out.get(f.id);
    if (res?.kind !== 'answer') continue;
    const c = soleCurrency(` ${res.answer.displayValue} `) ?? (/^[A-Z]{3}$/.test(res.answer.displayValue.trim()) ? res.answer.displayValue.trim() : null);
    if (c) picked.add(c);
  }
  if (picked.size === 1) return { currency: [...picked][0]!, why: 'the form\'s currency field is set to it', scale, period };

  // 3. The posting quotes its pay in one currency.
  const payLines = jobDescription
    .split(/(?<=[.!?\n])\s+/)
    .filter((s) => /salary|compensation|pay\s*range|base\s*pay|\bctc\b|per\s*(year|annum)|annual/i.test(s) && /\d/.test(s));
  const quoted = soleCurrency(payLines.join(' '));
  if (quoted) return { currency: quoted, why: 'the posting quotes its pay in it', scale, period };

  return { currency: null, why: '', scale, period };
}

// ------------------------------------------------------------- formatting ---

function roundNicely(n: number): number {
  if (n >= 10_000) return Math.round(n / 1000) * 1000;
  if (n >= 100) return Math.round(n / 10) * 10;
  return Math.round(n * 100) / 100;
}

function group(n: number, currency: string): string {
  return n.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { maximumFractionDigits: 2 });
}

// ------------------------------------------------------------------ apply ---

const TRUSTS_PLAIN_NUMBER = new Set(['PROFILE', 'RULE']);

/**
 * Rewrite every salary answer on the page into the currency, unit and period
 * its field asks for. Runs after the page is resolved, so a currency picked in
 * a neighbouring field can steer the amount.
 */
export async function convertSalaries(
  fields: FormField[],
  out: Map<string, Resolution>,
  opts: { jobDescription: string; profileCountry?: string | null },
): Promise<void> {
  for (const field of fields) {
    const res = out.get(field.id);
    if (res?.kind !== 'answer') continue;
    const { answer } = res;
    if (!answer.canonicalKey?.startsWith('compensation.') || CURRENCY_FIELD.test(field.label)) continue;
    if (typeof answer.value !== 'string' || answer.source === 'USER') continue;
    // Choice lists are matched against their own options; leave them be.
    if (field.options?.length) continue;

    // A remembered "120000" carries no currency of its own; only the
    // candidate's own saved facts are read in their home currency.
    const home = TRUSTS_PLAIN_NUMBER.has(answer.source) ? currencyOfCountry(opts.profileCountry) : null;
    const money = parseMoney(answer.value, home);
    if (!money) continue;

    const target = targetFor(field, fields, out, opts.jobDescription);
    const to = target.currency ?? money.currency;
    const sameCurrency = !to || to === money.currency;
    const period = target.period ?? money.period;
    const wantsNumber = field.kind === 'NUMBER';
    if (sameCurrency && !wantsNumber && target.scale === 1 && period === money.period) continue;
    if (!money.currency && !sameCurrency) continue;

    let rate = 1;
    let rateNote = '';
    if (!sameCurrency) {
      try {
        const r = await exchangeRate(money.currency!, to!);
        rate = r.rate;
        rateNote = ` at 1 ${money.currency} = ${r.rate} ${to} (${RATE_SOURCE}, ${r.asOf})`;
      } catch (err) {
        out.set(field.id, {
          kind: 'gap',
          gap: {
            fieldId: field.id,
            reason: 'NO_MATCH',
            suggestion: answer.value,
            suggestionRationale: `This asks for ${to} (${target.why}), but your saved figure "${answer.value}" is in ${money.currency} and today's exchange rate could not be fetched: ${(err as Error).message}`,
          },
        });
        continue;
      }
    }

    const perPeriod = (n: number) => (period === money.period ? n : period === 'month' ? n / 12 : n * 12);
    const conv = (n: number) => roundNicely(perPeriod(n * rate) / target.scale);
    const lo = conv(money.min);
    const hi = conv(money.max);
    const cur = to ?? money.currency ?? '';

    let value: string;
    let note = '';
    // "Expected CTC (in LPA)" wants "45", not "INR 45 lakhs".
    if (wantsNumber || target.scale !== 1 || answer.canonicalKey.endsWith('_min') || answer.canonicalKey.endsWith('_max')) {
      const n = answer.canonicalKey.endsWith('_max') ? hi : lo;
      value = String(n);
      if (lo !== hi && !answer.canonicalKey.endsWith('_min') && !answer.canonicalKey.endsWith('_max')) {
        note = ' The form takes one number, so the lower end of your range is used.';
      }
    } else {
      const amount = lo === hi ? group(lo, cur) : `${group(lo, cur)} - ${group(hi, cur)}`;
      value = `${cur} ${amount}${period === 'month' ? ' per month' : ''}`.trim();
    }

    const how = sameCurrency
      ? `Your saved "${answer.value}" written as the form asks`
      : `Your saved "${answer.value}" converted to ${to} (${target.why})${rateNote}`;
    res.answer = {
      ...answer,
      value,
      displayValue: value,
      rationale: `${how}.${note}${money.currency === home && home && !currenciesIn(answer.value).size ? ` Read as ${home}, your profile country's currency.` : ''}`,
    };
  }
}
