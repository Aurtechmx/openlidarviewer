/**
 * deviceGeneration.ts — which era of the graphics device a GPU resource
 * belongs to.
 *
 * A surface allocated on a device that has since been lost is not a surface of
 * the wrong size, and that is the trap: it is the right size, it is still
 * referenced, and every check that compares dimensions calls it current. The
 * only thing that distinguishes it is the device it came from, so the device
 * has to be counted.
 *
 * `DisplayState` already carries `deviceGeneration` and `historyTargets`
 * already reallocates when it changes. Nothing produced the number. This does.
 *
 * ── WHAT ADVANCES IT ────────────────────────────────────────────────────────
 * Four events, and each advances it on its own:
 *
 *   a WebGPU device is lost, so nothing made on it can be used again;
 *   a WebGL context is lost, for the same reason;
 *   a WebGL context is restored, which is a new context with nothing in it;
 *   the backend is replaced, which is a new device by definition.
 *
 * A lost-then-restored cycle therefore advances twice, and that is deliberate.
 * A counter that advanced once per cycle would have to know, at the moment of
 * the loss, whether a restore is coming, and it does not: a context can be
 * lost and never restored. Each edge invalidates on its own evidence, and the
 * number is only ever compared for equality, so counting an era twice costs
 * nothing while missing one shows pixels from a dead device.
 *
 * ── LOST IS NOT THE SAME QUESTION ───────────────────────────────────────────
 * The generation says which era a resource belongs to. It does not say whether
 * anything can be allocated right now, and between a loss and a restore the
 * answer is no. A caller that reallocated on the generation change alone would
 * ask a dead device for three textures. So `lost` is a separate flag, and the
 * allocation path is expected to consult it first.
 *
 * ── WHERE THE SIGNALS COME FROM ─────────────────────────────────────────────
 * The renderer reports a loss for both backends through one hook,
 * `onDeviceLost`, with the API named in the report: the WebGL backend calls it
 * from its own `webglcontextlost` listener and the WebGPU backend from the
 * device's `lost` promise. {@link wireRendererDeviceLoss} chains that hook
 * rather than listening beside it, so there is one place a loss is observed
 * and three's own handler still runs.
 *
 * Cancelling the loss event is the backend's job and it already does it, which
 * is what lets a restore follow. Nothing here cancels anything.
 *
 * A restore has no owner inside three: the canvas can raise
 * `webglcontextrestored` and the renderer will not act. The counter still
 * wants it, since a restored context is a new era, so
 * {@link watchContextRestore} listens for that one event; the Viewer's
 * reporter then rebuilds the renderer (`contextRecovery.ts`).
 *
 * Pure of three.js and of the DOM: both wirings take a structural shape, so a
 * fake drives them in Node.
 */

/** Something that happened to the graphics device. */
export type DeviceEvent =
  /** The WebGPU device's `lost` promise resolved. */
  | 'webgpu-device-lost'
  /** The canvas raised `webglcontextlost`. */
  | 'webgl-context-lost'
  /** The canvas raised `webglcontextrestored`. */
  | 'webgl-context-restored'
  /** The renderer was rebuilt on another backend. */
  | 'backend-replaced';

/** Whether an event leaves the device unusable until something else happens. */
const LEAVES_DEVICE_LOST: Readonly<Record<DeviceEvent, boolean>> = Object.freeze({
  'webgpu-device-lost': true,
  'webgl-context-lost': true,
  'webgl-context-restored': false,
  'backend-replaced': false,
});

/** The generation a session starts at. */
export const FIRST_GENERATION = 0;

/**
 * The counter, and the flag beside it.
 *
 * Deliberately dull: it counts and it remembers. Every decision about what to
 * do with a generation change belongs to whoever owns the resources.
 */
export class DeviceGeneration {
  private _generation = FIRST_GENERATION;
  private _lost = false;
  private _last: DeviceEvent | null = null;

  /** The era GPU resources made right now would belong to. */
  get current(): number {
    return this._generation;
  }

  /** Whether the device is unusable until it is restored or replaced. */
  get lost(): boolean {
    return this._lost;
  }

  /** The most recent event, for a diagnostics surface. */
  get lastEvent(): DeviceEvent | null {
    return this._last;
  }

  /**
   * Record an event and return the generation after it.
   *
   * Every event advances the counter, so a caller holding a resource tagged
   * with an older number can always tell. Repeating an event advances it
   * again: two losses without a restore between them are two reports of an
   * unusable device rather than one, and refusing the second would mean
   * deciding which report to believe.
   */
  note(event: DeviceEvent): number {
    this._generation += 1;
    this._lost = LEAVES_DEVICE_LOST[event];
    this._last = event;
    return this._generation;
  }

  /**
   * Whether a resource tagged `generation` may still be used.
   *
   * False while the device is lost, whatever the number says: a resource from
   * the current era is still unusable if the era ended.
   */
  isCurrent(generation: number): boolean {
    if (this._lost) return false;
    return Number.isFinite(generation) && generation === this._generation;
  }
}

/** What this needs from a canvas. */
export interface DeviceGenerationHost {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** What the renderer reports when a device is lost. */
export interface DeviceLossReport {
  /** Which API lost it, as three names them. */
  readonly api?: string;
  readonly message?: string;
  readonly reason?: string | null;
}

/** The renderer surface this needs: the one hook both backends call. */
export interface RendererWithDeviceLoss {
  onDeviceLost?: (info: DeviceLossReport) => void;
}

/**
 * Advance the generation whenever the renderer reports a lost device.
 *
 * Chains rather than replaces. Three's own handler logs the message and sets
 * its internal flag, and a wiring that dropped it would trade a diagnostic for
 * a counter. Returns the detach, which puts the previous handler back.
 *
 * The API name decides which event is recorded, and an unrecognised one is
 * recorded as a WebGPU loss: the counter's purpose is to invalidate, and a
 * loss it could not name is still a loss.
 */
export function wireRendererDeviceLoss(
  renderer: RendererWithDeviceLoss | null | undefined,
  generation: DeviceGeneration,
  onChange?: (event: DeviceEvent, generation: number) => void,
): () => void {
  if (!renderer) return () => {};
  const previous = renderer.onDeviceLost;
  renderer.onDeviceLost = (info: DeviceLossReport): void => {
    const event: DeviceEvent = String(info?.api ?? '').toLowerCase() === 'webgl'
      ? 'webgl-context-lost'
      : 'webgpu-device-lost';
    const next = generation.note(event);
    try {
      onChange?.(event, next);
    } catch {
      // A reporter that throws must not swallow three's own handler below.
    }
    previous?.call(renderer, info);
  };
  return () => {
    renderer.onDeviceLost = previous;
  };
}

/**
 * Advance the generation when a WebGL context is restored.
 *
 * The one event with no other owner. The loss is reported by the renderer and
 * cancelled by its backend; a restore is reported by nothing inside three. Listening for it keeps the counter honest about a context
 * that exists again, which is what decides whether anything held from before
 * may be used.
 */
export function watchContextRestore(
  canvas: DeviceGenerationHost,
  generation: DeviceGeneration,
  onChange?: (event: DeviceEvent, generation: number) => void,
): () => void {
  const onRestored = (): void => {
    const next = generation.note('webgl-context-restored');
    try {
      onChange?.('webgl-context-restored', next);
    } catch {
      // A reporter that throws must not stop the recovery it was told about.
    }
  };
  canvas.addEventListener('webglcontextrestored', onRestored);
  return () => canvas.removeEventListener('webglcontextrestored', onRestored);
}

/**
 * Watch both sources of device change and return one detach.
 *
 * The loss comes from the renderer's hook and the restore from the canvas, and
 * a caller that wired them separately would hold two detaches and eventually
 * call one. Dropping the loss detach is the worse half: the hook is a closure
 * over the object that installed it, so a disposed viewer would stay reachable
 * and keep advancing a counter nothing reads.
 */
export function watchDeviceChanges(
  canvas: DeviceGenerationHost,
  renderer: RendererWithDeviceLoss | null | undefined,
  generation: DeviceGeneration,
  onChange?: (event: DeviceEvent, generation: number) => void,
): () => void {
  const detachLoss = wireRendererDeviceLoss(renderer, generation, onChange);
  const detachRestore = watchContextRestore(canvas, generation, onChange);
  return () => {
    detachLoss();
    detachRestore();
  };
}
