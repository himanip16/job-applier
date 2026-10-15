import type { AtsAdapter } from './types.js';
import { greenhouseAdapter } from './adapters/greenhouse.js';
import { leverAdapter } from './adapters/lever.js';
import { ashbyAdapter } from './adapters/ashby.js';
import { workableAdapter } from './adapters/workable.js';
import { googleAdapter } from './adapters/google.js';
import { microsoftAdapter } from './adapters/microsoft.js';
import { appleAdapter } from './adapters/apple.js';
import { workdayAdapter } from './adapters/workday.js';
import { smartRecruitersAdapter } from './adapters/smartrecruiters.js';
import { ripplingAdapter } from './adapters/rippling.js';
import { turboHireAdapter } from './adapters/turbohire.js';
import { oracleHcmAdapter } from './adapters/oracleHcm.js';
import { genericAdapter } from './adapters/generic.js';

/** Order matters: generic must be last, it matches everything. */
export const ADAPTERS: AtsAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workableAdapter,
  googleAdapter,
  microsoftAdapter,
  appleAdapter,
  workdayAdapter,
  smartRecruitersAdapter,
  ripplingAdapter,
  turboHireAdapter,
  oracleHcmAdapter,
  genericAdapter,
];

export function adapterFor(url: string): AtsAdapter {
  return ADAPTERS.find((a) => a.matches(url)) ?? genericAdapter;
}

export function adapterById(id: string): AtsAdapter {
  return ADAPTERS.find((a) => a.id === id) ?? genericAdapter;
}
