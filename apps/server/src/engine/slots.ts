/**
 * How many applications are being driven at once.
 *
 * A slot is a browser tab actively filling a form. A run waiting on you - a
 * question, the review gate, a wall you have to clear - is not using its slot,
 * so it gives it back for the length of the wait and the next queued job starts
 * in another tab. Without that, a single run parked on a question held up
 * every application behind it, however many slots there were.
 *
 * Parallel tabs in one headed window are safe because Playwright turns on
 * Chromium's focus emulation for every page: a background tab still believes
 * it has focus, which is what comboboxes and blur-validation check.
 */
export const CONCURRENCY = Math.max(1, Number(process.env.RUN_CONCURRENCY) || 3);

const holding = new Set<string>();
/** Runs coming back from a wait. Served before new jobs, so a half-filled form is never starved. */
const resuming: Array<{ id: string; go: () => void }> = [];
let onFree: () => void = () => {};

/** The queue's hook for starting the next job when a slot opens. */
export function whenSlotFrees(fn: () => void): void {
  onFree = fn;
}

/** Take a slot for a new run if one is free. */
export function tryTake(applicationId: string): boolean {
  if (holding.size >= CONCURRENCY) return false;
  holding.add(applicationId);
  return true;
}

/** Give a slot back. Safe to call for a run that is not holding one. */
export function give(applicationId: string): void {
  if (!holding.delete(applicationId)) return;
  const next = resuming.shift();
  if (next) {
    holding.add(next.id);
    next.go();
    return;
  }
  onFree();
}

function reclaim(applicationId: string): Promise<void> {
  if (tryTake(applicationId)) return Promise.resolve();
  return new Promise((go) => resuming.push({ id: applicationId, go }));
}

/**
 * Wait on a person without holding a slot.
 *
 * Once the wait ends, the run takes a slot back before it touches the page
 * again. A wait that ends in an error (the tab closed) does not: the run is
 * over, and queueing for a slot just to exit would hold it up for nothing.
 */
export async function whileWaitingOnHuman<T>(applicationId: string, wait: Promise<T>): Promise<T> {
  give(applicationId);
  const value = await wait;
  await reclaim(applicationId);
  return value;
}

export function runningIds(): string[] {
  return [...holding];
}
