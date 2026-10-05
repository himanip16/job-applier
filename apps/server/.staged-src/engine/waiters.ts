/**
 * Pause points.
 *
 * A run that hits an unanswerable question, or that is waiting for you to
 * approve a submission, does not tear down and restart later - it parks on a
 * promise while the browser page stays exactly as it is, filled and open.
 * That matters for two reasons: re-driving forty react-select dropdowns to get
 * back to where you were is slow and fragile, and any captcha token the page
 * has already earned is bound to that page instance.
 */
type Resolver<T> = (value: T) => void;

const waiters = new Map<string, Resolver<unknown>>();

export function park<T>(key: string): Promise<T> {
  return new Promise<T>((resolve) => {
    waiters.set(key, resolve as Resolver<unknown>);
  });
}

/** Returns false when nothing was parked under this key. */
export function release(key: string, value: unknown): boolean {
  const resolve = waiters.get(key);
  if (!resolve) return false;
  waiters.delete(key);
  resolve(value);
  return true;
}

export function isParked(key: string): boolean {
  return waiters.has(key);
}

export function abandon(key: string): void {
  waiters.delete(key);
}

export const questionsKey = (applicationId: string) => `questions:${applicationId}`;
export const reviewKey = (applicationId: string) => `review:${applicationId}`;
export const blockerKey = (applicationId: string) => `blocker:${applicationId}`;
