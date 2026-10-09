import { stripHtml } from './text.js';

/**
 * The schema.org JobPosting a careers page embeds for search engines.
 *
 * Google for Jobs only lists a posting that describes itself in a
 * `<script type="application/ld+json">` block, so most careers sites ship one,
 * and it carries what the rendered page makes hard to find: where the job is,
 * when it was posted, whether it is remote. Only what the block states is
 * returned; a field it leaves out stays undefined.
 */
export interface LdJobPosting {
  title?: string;
  url?: string;
  descriptionText?: string;
  location?: string;
  remote: boolean;
  postedAt?: Date;
  companyName?: string;
}

type Node = Record<string, unknown>;

/** Every JobPosting in a page's JSON-LD blocks, wherever it sits: top level, an array, or an @graph. */
export function jobPostingsFromLd(blocks: string[]): LdJobPosting[] {
  const out: LdJobPosting[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    const node = value as Node;
    if (types(node).includes('jobposting')) {
      out.push(toPosting(node));
      return;
    }
    for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity']) visit(node[key], depth + 1);
  };
  for (const block of blocks) {
    try {
      visit(JSON.parse(block), 0);
    } catch {
      // A malformed block is the site's bug; the rest of the page still counts.
    }
  }
  return out;
}

const types = (node: Node): string[] =>
  [node['@type']].flat().filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());

const text = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined;
  if (v && typeof v === 'object' && !Array.isArray(v)) return text((v as Node).name);
  return undefined;
};

function toPosting(node: Node): LdJobPosting {
  const places = [node.jobLocation].flat().filter((p): p is Node => !!p && typeof p === 'object');
  const locations = places.map(placeText).filter((l): l is string => !!l);
  // "Remote, open to India" is stated as a location requirement rather than a place.
  const requirements = [node.applicantLocationRequirements].flat().map(text).filter((l): l is string => !!l);
  const remote = [node.jobLocationType].flat().some((t) => typeof t === 'string' && /telecommute/i.test(t));

  const location = [...new Set(locations.length ? locations : requirements.map((r) => (remote ? `Remote - ${r}` : r)))].join('; ');
  const posted = typeof node.datePosted === 'string' ? new Date(node.datePosted) : undefined;
  const description = typeof node.description === 'string' ? stripHtml(node.description) : undefined;

  return {
    title: text(node.title),
    url: text(node.url),
    descriptionText: description || undefined,
    location: location || undefined,
    remote,
    postedAt: posted && !Number.isNaN(posted.getTime()) ? posted : undefined,
    companyName: text(node.hiringOrganization),
  };
}

/** "Bengaluru, Karnataka, India" from a Place, however much of its address it filled in. */
function placeText(place: Node): string | undefined {
  const address = place.address;
  if (typeof address === 'string') return address.trim() || undefined;
  if (address && typeof address === 'object') {
    const a = address as Node;
    const parts = [text(a.addressLocality), text(a.addressRegion), text(a.addressCountry)].filter(Boolean);
    if (parts.length) return [...new Set(parts)].join(', ');
  }
  return text(place.name);
}
