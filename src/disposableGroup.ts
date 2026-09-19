/**
 * disposableGroup.ts — one owner for a bounded set of teardown callbacks.
 *
 * Listeners were added in one place and removed in another, or not at all:
 * NavBar registered twelve and removed two. The imbalance is not visible at a
 * glance because the two halves sit far apart, so the usual failure is a
 * listener that outlives the thing it was speaking for.
 *
 * A group keeps the registration and its teardown in the same statement. It is
 * deliberately tiny and imports nothing: it is not a lifecycle framework and
 * owns no policy about when disposal happens, only that everything registered
 * is released exactly once.
 */

/** A teardown callback. Must tolerate being called after its target is gone. */
export type Teardown = () => void;

/** The subset of EventTarget this needs, so a caller can pass a test double. */
interface ListenerTarget {
  addEventListener(type: string, handler: never, options?: unknown): void;
  removeEventListener(type: string, handler: never, options?: unknown): void;
}

export class DisposableGroup {
  private _teardowns: Teardown[] = [];
  private _disposed = false;

  /** Whether dispose() has run. */
  get disposed(): boolean {
    return this._disposed;
  }

  /** How many teardowns are still pending. Zero after disposal. */
  get size(): number {
    return this._teardowns.length;
  }

  /**
   * Register a teardown. Adding to an already-disposed group runs the callback
   * at once rather than retaining it, so a late registration cannot outlive the
   * group it was handed to.
   */
  add(teardown: Teardown): void {
    if (this._disposed) {
      teardown();
      return;
    }
    this._teardowns.push(teardown);
  }

  /** Add a listener and its removal together. */
  addListener<T extends ListenerTarget>(
    target: T,
    type: string,
    handler: unknown,
    options?: unknown,
  ): void {
    target.addEventListener(type, handler as never, options);
    this.add(() => target.removeEventListener(type, handler as never, options));
  }

  /**
   * Run every teardown, most recent first, and forget them.
   *
   * Idempotent: a second call does nothing. One throwing teardown does not
   * strand the rest; the first error is rethrown once the others have run, so a
   * failure is still reported without leaking what followed it.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const pending = this._teardowns;
    this._teardowns = [];
    let firstError: unknown;
    for (let i = pending.length - 1; i >= 0; i--) {
      try {
        pending[i]();
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
