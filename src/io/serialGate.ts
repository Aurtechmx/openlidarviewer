/**
 * serialGate.ts
 *
 * A minimal FIFO mutex. `acquire()` resolves to a `release` function only once
 * every earlier acquirer has released, so callers run one-at-a-time in call
 * order. Used to serialise access to the single shared parse worker, whose
 * per-load `onmessage` handler would otherwise be clobbered by an overlapping
 * load (one hangs, the other resolves with the wrong result).
 *
 * The internal tail promise only ever resolves (never rejects), so a caller
 * that throws between acquire and release cannot wedge the queue — provided it
 * calls `release()` in a `finally`.
 */

export interface SerialGate {
  /** Wait your turn; resolves to a one-shot release fn. Call it in `finally`. */
  acquire(): Promise<() => void>;
}

export function createSerialGate(): SerialGate {
  let tail: Promise<void> = Promise.resolve();
  return {
    async acquire(): Promise<() => void> {
      const previous = tail;
      let release: () => void = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    },
  };
}
