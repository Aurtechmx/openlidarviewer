/**
 * gpuErrorLedger.ts
 *
 * Pure bookkeeping and wiring for GPU-error reporting, extracted from `Viewer`
 * (which constructs a real `WebGPURenderer` and so cannot be instantiated under
 * vitest). Splitting the logic out lets it be unit-tested without a GPU.
 *
 * Two pieces, both device-free:
 *
 *  - `GpuErrorLedger` — de-dup + cap + reset for surfaced messages. A broken
 *    shader/pipeline emits the same validation error every frame; the ledger
 *    admits each distinct message once, bounds the remembered set so a
 *    pathological stream of distinct messages can't grow it without limit, and
 *    can be reset on each new scan open so a fresh scan's error is never
 *    suppressed because an earlier scan produced the same text.
 *
 *  - `wireGpuDeviceErrors` — attaches the `uncapturederror` + `device.lost`
 *    handlers to a WebGPU device-like object and returns a detach function. A
 *    fake device object drives it in tests; `Viewer` passes the real backend
 *    device.
 *
 * Neither piece references `Viewer`, three.js, or the DOM.
 */

/** Default cap on the remembered distinct-message set. */
export const GPU_ERROR_CAP = 64;

export interface GpuErrorLedgerOptions {
  /** Cap on the remembered distinct-message set (default {@link GPU_ERROR_CAP}). */
  readonly cap?: number;
}

/**
 * Remembers which GPU-error messages have already been surfaced so each is
 * reported once, with a bounded history and a device-lost suppression rule.
 */
export class GpuErrorLedger {
  private _seen = new Set<string>();
  private _deviceLost = false;
  private readonly _cap: number;

  constructor(options: GpuErrorLedgerOptions = {}) {
    const cap = options.cap ?? GPU_ERROR_CAP;
    // A non-positive or non-finite cap would make the ledger admit-then-clear on
    // every message, defeating dedup; fall back to the default in that case.
    this._cap = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : GPU_ERROR_CAP;
  }

  /**
   * Decide whether `message` should be surfaced now, recording it if so.
   * Returns true the first time a distinct message is seen (subject to the
   * device-lost rule), false when it is a duplicate or suppressed.
   *
   * Once the device is lost every subsequent frame raises fresh uncaptured
   * errors from the dead device — pure noise. The one actionable message
   * (`GPUDeviceLost…`) has already been surfaced, so anything that is not itself
   * a device-lost message is dropped.
   */
  admit(message: string): boolean {
    if (this._deviceLost && !message.startsWith('GPUDeviceLost')) return false;
    if (this._seen.has(message)) return false;
    // Bound: dropping the history just means an old message could be re-reported
    // later — harmless, and far better than an unbounded set.
    if (this._seen.size >= this._cap) this._seen.clear();
    this._seen.add(message);
    return true;
  }

  /**
   * Mark the device as lost so post-loss per-frame noise is suppressed. Not
   * cleared by {@link reset} — a lost device stays lost until reload.
   */
  noteDeviceLost(): void {
    this._deviceLost = true;
  }

  /** True once the device has been marked lost. */
  get deviceLost(): boolean {
    return this._deviceLost;
  }

  /** Number of distinct messages currently remembered (introspection/tests). */
  get size(): number {
    return this._seen.size;
  }

  /**
   * Forget the messages surfaced so far. Called when a new scan opens so a
   * fresh scan's error is never suppressed because an earlier scan happened to
   * emit the same text. Leaves the device-lost flag intact.
   */
  reset(): void {
    if (this._seen.size > 0) this._seen = new Set<string>();
  }
}

/** The subset of a WebGPU `GPUDevice` this module touches. */
export interface GpuDeviceLike {
  addEventListener?: (type: string, cb: (e: unknown) => void) => void;
  removeEventListener?: (type: string, cb: (e: unknown) => void) => void;
  lost?: Promise<{ reason?: string; message?: string }>;
}

export interface GpuDeviceErrorHandlers {
  /** Called with a formatted message for each uncaptured error. */
  readonly onError: (message: string) => void;
  /** Called once, if and when `device.lost` resolves, with the reload message. */
  readonly onDeviceLost?: (message: string) => void;
}

/**
 * Format an `uncapturederror` event into a stable `Kind: detail` string.
 * Defensive because the event/error shape is not part of any public API.
 */
export function formatUncapturedError(event: unknown): string {
  const gpuError = (event as { error?: { message?: string; constructor?: { name?: string } } }).error;
  const kind = gpuError?.constructor?.name ?? 'GPUError';
  const detail = gpuError?.message ?? String(event);
  return `${kind}: ${detail}`;
}

/** Format a `device.lost` info payload into the actionable reload message. */
export function formatDeviceLost(info: { reason?: string; message?: string } | undefined): string {
  const reason = info?.reason ?? 'unknown';
  // Only interpose the driver detail (and its trailing space) when present, so
  // a payload without a message doesn't leave a double space before "Reload".
  const detail = info?.message ? `${info.message} ` : '';
  return `GPUDeviceLost: the graphics device was lost (${reason}). ${detail}Reload the page to continue.`;
}

/**
 * Attach `uncapturederror` + `device.lost` handlers to a WebGPU device-like
 * object. Returns a detach function that removes the `uncapturederror` listener
 * and neutralises the (un-cancellable) `device.lost` promise via an `active`
 * flag, or `null` when there is no usable device (e.g. the WebGL 2 fallback).
 *
 * Pure with respect to `Viewer` and the DOM: a fake device drives it in tests.
 */
export function wireGpuDeviceErrors(
  device: GpuDeviceLike | null | undefined,
  handlers: GpuDeviceErrorHandlers,
): (() => void) | null {
  if (!device || typeof device.addEventListener !== 'function') return null;
  let active = true;
  const handler = (event: unknown): void => {
    if (!active) return;
    handlers.onError(formatUncapturedError(event));
  };
  device.addEventListener('uncapturederror', handler);
  // `device.lost` resolves if the GPU device is reset or evicted — a separate
  // channel from uncapturederror. Left unhandled it leaves a permanently blank
  // canvas with no signal; surface it once so the host can prompt a reload.
  if (device.lost && typeof device.lost.then === 'function') {
    void device.lost.then((info) => {
      if (!active) return;
      handlers.onDeviceLost?.(formatDeviceLost(info));
    });
  }
  return (): void => {
    active = false;
    if (typeof device.removeEventListener === 'function') {
      device.removeEventListener('uncapturederror', handler);
    }
  };
}
