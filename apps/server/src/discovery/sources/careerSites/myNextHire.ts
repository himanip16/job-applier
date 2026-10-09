import { postJson } from '../http.js';
import { looksRemote } from '../text.js';
import type { DiscoveredJob, Source } from '../types.js';
import { dedupe } from './shared.js';

interface Req {
  reqId: number;
  reqTitle: string;
  buName?: string;
  location?: string;
  locationAddress?: string;
  jdDisplay?: string;
  locationList?: { office?: string; address?: string }[];
}

/**
 * The posting's own page: the tenant's job board, with the posting as base64
 * JSON in `p`, written exactly as the board's own links write it.
 */
const jdLink = (origin: string, reqId: number): string => {
  const context = { pageType: 'jd', cvSource: 'careers', reqId, requester: { id: '', code: '', name: '' }, page: 'careers', bufilter: -1, customFields: {} };
  const p = Buffer.from(JSON.stringify(context)).toString('base64');
  return `${origin}/employer/jobs/careers#?src%3Dcareers%26p%3D${p}&page=careers`;
};

/**
 * MyNextHire, which Swiggy's careers site runs on.
 *
 * Handle: the tenant, e.g. "swiggy" for swiggy.mynexthire.com. The whole list comes
 * back in one call with full descriptions, so there is nothing to page or
 * hydrate. It has no posting date - `approvedOn` is when the requisition was
 * approved internally - so none is given.
 */
export const myNextHireSource: Source = {
  id: 'mynexthire',
  handleHint: 'tenant, e.g. "swiggy" for swiggy.mynexthire.com',

  async fetchJobs(handle) {
    if (!/^[a-z0-9-]+$/i.test(handle)) throw new Error(`MyNextHire handle should be the tenant, got "${handle}"`);
    const origin = `https://${handle}.mynexthire.com`;
    const res = await postJson<{ reqDetailsBOList?: Req[] }>(`${origin}/employer/careers/reqlist/get`, {
      source: 'careers',
      code: '',
      filterByBuId: -1,
      filterByLocation: '',
      filterBySearch: '',
      filterByTeam: -1,
      page: 'careers',
    });
    return dedupe((res.reqDetailsBOList ?? []).map((r): DiscoveredJob => {
      const location = r.locationList?.length
        ? r.locationList.map((l) => l.address || l.office).filter(Boolean).join('; ')
        : r.locationAddress || r.location;
      const description = (r.jdDisplay ?? '').trim();
      return {
        url: jdLink(origin, r.reqId),
        ats: 'mynexthire',
        title: r.reqTitle,
        companyName: handle,
        location: location || undefined,
        remote: looksRemote(`${r.reqTitle} ${location ?? ''}`),
        descriptionText: description,
      };
    }));
  },
};
