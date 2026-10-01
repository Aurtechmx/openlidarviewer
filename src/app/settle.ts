/**
 * Run `fn` now and hand back its result as a promise. A throw becomes a
 * rejection, as it would in an `async` function.
 */
export function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
