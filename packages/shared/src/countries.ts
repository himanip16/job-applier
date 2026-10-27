/**
 * Countries a job search can be pointed at.
 *
 * Postings rarely spell out the country - "Bengaluru" or "Gurugram, HR" is far
 * more common than "India" - so each entry carries the cities that stand for
 * it. The list is short on purpose: the countries this tool is actually used
 * for, not every ISO code.
 */
export interface Country {
  /** ISO 3166-1 alpha-2, which is what the search provider geo-targets on. */
  code: string;
  name: string;
  /** Other ways a posting's location says the same thing. */
  aliases: string[];
  /** Administrative subdivision codes (ISO 3166-2) for UI5 value-help matching. */
  states?: State[];
}

export interface State {
  /** ISO 3166-2 subdivision code (e.g., "KA" for Karnataka). */
  code: string;
  /** Full state/province name. */
  name: string;
  /** Common variants and aliases. */
  aliases: string[];
}

export const COUNTRIES: Country[] = [
  {
    code: 'IN',
    name: 'India',
    aliases: ['bengaluru', 'bangalore', 'mumbai', 'pune', 'hyderabad', 'chennai', 'delhi', 'new delhi', 'gurugram', 'gurgaon', 'noida', 'kolkata', 'ahmedabad', 'mohali', 'karnataka', 'maharashtra', 'telangana', 'haryana', 'tamil nadu', 'ind'],
    states: [
      { code: 'KA', name: 'Karnataka', aliases: ['karnataka'] },
      { code: 'MH', name: 'Maharashtra', aliases: ['maharashtra'] },
      { code: 'TN', name: 'Tamil Nadu', aliases: ['tamil nadu'] },
      { code: 'DL', name: 'Delhi', aliases: ['delhi', 'new delhi'] },
      { code: 'TS', name: 'Telangana', aliases: ['telangana'] },
      { code: 'HR', name: 'Haryana', aliases: ['haryana'] },
      { code: 'UP', name: 'Uttar Pradesh', aliases: ['uttar pradesh', 'up'] },
      { code: 'GJ', name: 'Gujarat', aliases: ['gujarat'] },
      { code: 'WB', name: 'West Bengal', aliases: ['west bengal'] },
      { code: 'KL', name: 'Kerala', aliases: ['kerala'] },
      { code: 'AP', name: 'Andhra Pradesh', aliases: ['andhra pradesh', 'ap'] },
      { code: 'PB', name: 'Punjab', aliases: ['punjab'] },
      { code: 'RJ', name: 'Rajasthan', aliases: ['rajasthan'] },
      { code: 'MP', name: 'Madhya Pradesh', aliases: ['madhya pradesh', 'mp'] },
    ],
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    aliases: ['uk', 'u.k.', 'england', 'scotland', 'wales', 'london', 'manchester', 'edinburgh', 'cambridge', 'bristol', 'leeds', 'birmingham', 'great britain'],
    states: [
      { code: 'ENG', name: 'England', aliases: ['england'] },
      { code: 'SCT', name: 'Scotland', aliases: ['scotland'] },
      { code: 'WLS', name: 'Wales', aliases: ['wales'] },
      { code: 'NIR', name: 'Northern Ireland', aliases: ['northern ireland'] },
    ],
  },
  {
    code: 'US',
    name: 'United States',
    aliases: ['usa', 'u.s.', 'us', 'new york', 'san francisco', 'seattle', 'austin', 'boston', 'chicago', 'los angeles', 'denver', 'california', 'texas', 'washington', 'nyc'],
    states: [
      { code: 'CA', name: 'California', aliases: ['california', 'ca'] },
      { code: 'NY', name: 'New York', aliases: ['new york', 'ny'] },
      { code: 'TX', name: 'Texas', aliases: ['texas', 'tx'] },
      { code: 'WA', name: 'Washington', aliases: ['washington', 'wa'] },
      { code: 'MA', name: 'Massachusetts', aliases: ['massachusetts', 'ma'] },
      { code: 'IL', name: 'Illinois', aliases: ['illinois', 'il'] },
      { code: 'CO', name: 'Colorado', aliases: ['colorado', 'co'] },
      { code: 'FL', name: 'Florida', aliases: ['florida', 'fl'] },
    ],
  },
  {
    code: 'CA',
    name: 'Canada',
    aliases: ['toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'ontario', 'british columbia', 'quebec'],
    states: [
      { code: 'ON', name: 'Ontario', aliases: ['ontario'] },
      { code: 'BC', name: 'British Columbia', aliases: ['british columbia', 'bc'] },
      { code: 'QC', name: 'Quebec', aliases: ['quebec'] },
      { code: 'AB', name: 'Alberta', aliases: ['alberta'] },
    ],
  },
  { code: 'IE', name: 'Ireland', aliases: ['dublin', 'cork', 'galway'] },
  { code: 'DE', name: 'Germany', aliases: ['berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'deutschland'] },
  { code: 'NL', name: 'Netherlands', aliases: ['amsterdam', 'rotterdam', 'utrecht', 'the hague', 'eindhoven'] },
  { code: 'FR', name: 'France', aliases: ['paris', 'lyon', 'toulouse'] },
  { code: 'ES', name: 'Spain', aliases: ['madrid', 'barcelona', 'valencia'] },
  { code: 'PT', name: 'Portugal', aliases: ['lisbon', 'porto'] },
  { code: 'PL', name: 'Poland', aliases: ['warsaw', 'krakow', 'kraków', 'wroclaw', 'wrocław'] },
  { code: 'SE', name: 'Sweden', aliases: ['stockholm', 'gothenburg'] },
  { code: 'CH', name: 'Switzerland', aliases: ['zurich', 'zürich', 'geneva', 'basel'] },
  { code: 'SG', name: 'Singapore', aliases: [] },
  { code: 'AE', name: 'United Arab Emirates', aliases: ['uae', 'dubai', 'abu dhabi'] },
  { code: 'AU', name: 'Australia', aliases: ['sydney', 'melbourne', 'brisbane', 'perth'] },
  { code: 'JP', name: 'Japan', aliases: ['tokyo', 'osaka'] },
];

export function countryByCode(code: string | null | undefined): Country | undefined {
  return COUNTRIES.find((c) => c.code === code?.toUpperCase());
}

/** Best guess from free text such as a profile's country box ("India", "UK"). */
export function countryFromText(text: string | null | undefined): Country | undefined {
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return undefined;
  return COUNTRIES.find((c) => c.code.toLowerCase() === t || c.name.toLowerCase() === t || c.aliases.includes(t));
}

/**
 * Is a posting in this country, as far as its location line says?
 *
 * Remote postings and postings with no location are kept: neither can be
 * ruled out, and dropping a remote role you could take is the worse mistake.
 */
export function locatedIn(location: string | null | undefined, remote: boolean, country: Country): boolean {
  const loc = (location ?? '').toLowerCase();
  if (!loc.trim()) return true;

  // A place name ("Bengaluru", "India") is strong evidence; a bare two-letter
  // code is not - "USA - Remote, IN" is Indiana, not India.
  if ([country.name.toLowerCase(), ...country.aliases].some((w) => mentionsWord(loc, w))) return true;

  // Any other country named, by name, alias or code, rules it out. Short
  // aliases count here too: "Remote - USA" and "US-CA-Menlo Park" are both
  // American jobs, and a substring test on long names alone waved them through.
  const other = COUNTRIES.some(
    (c) => c !== country && [c.name.toLowerCase(), c.code.toLowerCase(), ...c.aliases].some((w) => mentionsWord(loc, w)),
  );
  if (other) return false;

  if (mentionsWord(loc, country.code.toLowerCase())) return true;
  // "Remote" with no other country named is open to this one too.
  return remote || /\bremote\b|\banywhere\b/.test(loc);
}

const mentionsWord = (text: string, word: string): boolean =>
  new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(text);

/**
 * Cities, each with the spellings postings use for it.
 *
 * "Bangalore" and "Bengaluru" are one place, and a city filter that listed
 * them twice would split the count and hide half the jobs from each choice.
 */
export const CITIES: { name: string; country: string; variants: string[] }[] = [
  { name: 'Bengaluru', country: 'IN', variants: ['bengaluru', 'bangalore'] },
  { name: 'Hyderabad', country: 'IN', variants: ['hyderabad'] },
  { name: 'Gurugram', country: 'IN', variants: ['gurugram', 'gurgaon'] },
  { name: 'Delhi NCR', country: 'IN', variants: ['new delhi', 'delhi', 'noida'] },
  { name: 'Mumbai', country: 'IN', variants: ['mumbai'] },
  { name: 'Pune', country: 'IN', variants: ['pune'] },
  { name: 'Chennai', country: 'IN', variants: ['chennai'] },
  { name: 'Kolkata', country: 'IN', variants: ['kolkata'] },
  { name: 'Ahmedabad', country: 'IN', variants: ['ahmedabad'] },
  { name: 'Mohali', country: 'IN', variants: ['mohali'] },
  { name: 'London', country: 'GB', variants: ['london'] },
  { name: 'New York', country: 'US', variants: ['new york', 'nyc'] },
  { name: 'San Francisco', country: 'US', variants: ['san francisco'] },
  { name: 'Seattle', country: 'US', variants: ['seattle'] },
  { name: 'Toronto', country: 'CA', variants: ['toronto'] },
  { name: 'Dublin', country: 'IE', variants: ['dublin'] },
  { name: 'Berlin', country: 'DE', variants: ['berlin'] },
  { name: 'Amsterdam', country: 'NL', variants: ['amsterdam'] },
  { name: 'Singapore', country: 'SG', variants: ['singapore'] },
  { name: 'Dubai', country: 'AE', variants: ['dubai'] },
];

/** Every known city a location line names, by canonical name. */
export function citiesIn(location: string | null | undefined): string[] {
  const loc = (location ?? '').toLowerCase();
  if (!loc) return [];
  return CITIES.filter((c) => c.variants.some((v) => mentionsWord(loc, v))).map((c) => c.name);
}

/**
 * Normalize a city name to its canonical form for UI5 value-help matching.
 * "Bangalore" → "Bengaluru", "Gurgaon" → "Gurugram", etc.
 */
export function normalizeCityName(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const city = CITIES.find((c) => c.variants.includes(lower) || c.name.toLowerCase() === lower);
  return city ? city.name : t;
}

/**
 * Normalize a state/province name to its ISO code for UI5 value-help matching.
 * "Karnataka" → "KA", "Maharashtra" → "MH", etc.
 */
export function normalizeStateCode(text: string | null | undefined, countryCode?: string | null): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const country = countryCode ? countryByCode(countryCode) : undefined;

  // First check if it's already a code
  if (/^[A-Z]{2}$/i.test(t) && country?.states?.some((s) => s.code.toUpperCase() === t.toUpperCase())) {
    return t.toUpperCase();
  }

  // Find by name or alias
  if (country?.states) {
    const state = country.states.find(
      (s) => s.name.toLowerCase() === lower || s.aliases.some((a) => a.toLowerCase() === lower),
    );
    return state ? state.code : null;
  }

  // Search across all countries if no country specified
  for (const c of COUNTRIES) {
    if (c.states) {
      const state = c.states.find(
        (s) => s.name.toLowerCase() === lower || s.aliases.some((a) => a.toLowerCase() === lower),
      );
      if (state) return state.code;
    }
  }

  return null;
}

/**
 * Normalize currency names to ISO codes for UI5 value-help matching.
 * "Indian Rupee" → "INR", "US Dollar" → "USD", etc.
 */
export function normalizeCurrencyCode(text: string | null | undefined): string | null {
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return null;

  const CURRENCY_MAP: Record<string, string> = {
    'indian rupee': 'INR',
    'rupee': 'INR',
    'inr': 'INR',
    '₹': 'INR',
    'us dollar': 'USD',
    'dollar': 'USD',
    'usd': 'USD',
    '$': 'USD',
    'euro': 'EUR',
    'eur': 'EUR',
    '€': 'EUR',
    'british pound': 'GBP',
    'pound': 'GBP',
    'gbp': 'GBP',
    '£': 'GBP',
    'japanese yen': 'JPY',
    'yen': 'JPY',
    'jpy': 'JPY',
    '¥': 'JPY',
    'canadian dollar': 'CAD',
    'cad': 'CAD',
    'australian dollar': 'AUD',
    'aud': 'AUD',
    'singapore dollar': 'SGD',
    'sgd': 'SGD',
    'united arab emirates dirham': 'AED',
    'aed': 'AED',
    'dirham': 'AED',
  };

  return CURRENCY_MAP[t] || null;
}
