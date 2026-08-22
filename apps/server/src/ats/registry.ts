import type { AtsAdapter } from './types.js';
import { greenhouseAdapter } from './adapters/greenhouse.js';
import { leverAdapter } from './adapters/lever.js';
import { ashbyAdapter } from './adapters/ashby.js';
import { workableAdapter } from './adapters/workable.js';
import { genericAdapter } from './adapters/generic.js';

/** Order matters: generic must be last, it matches everything. */
export const ADAPTERS: AtsAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workableAdapter,
  genericAdapter,
];

export function adapterFor(url: string): AtsAdapter {
  return ADAPTERS.find((a) => a.matches(url)) ?? genericAdapter;
}

export function adapterById(id: string): AtsAdapter {
  return ADAPTERS.find((a) => a.id === id) ?? genericAdapter;
}
