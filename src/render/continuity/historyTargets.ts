/**
 * historyTargets.ts
 *
 * The render targets the accumulation history lives in, and their lifetime.
 *
 * Three surfaces persist between frames: the colour built so far, the depth it
 * was built at, and each pixel's support. They are allocated together because
 * they are only useful together, and a partial set is worse than none: a colour
 * history with no depth beside it is the photographic accumulation this
 * renderer must not do.
 *
 * Two different things invalidate a history and they are not the same repair.
 * A changed display state means the contents describe a different picture, so
 * the pixels are wrong and the buffers are the right shape: clear them. A
 * changed backing store means the buffers are the wrong shape: free them and
 * make new ones. Treating an epoch change as a resize would reallocate three
 * textures on every camera nudge, which costs more than the accumulation saves.
 *
 * Above the ceiling nothing is allocated at all and the caller is told so, which
 * is the failure path working rather than an error: source rendering is a worse
 * picture, a lost device is a lost tab.
 *
 * The device is reached through a factory so the lifetime can be exercised
 * without one. What the tests below cover is allocation, replacement, clearing
 * and release. What they cannot cover is whether a real backend accepts these
 * formats or samples them correctly, and no test here should be read as saying
 * it does.
 *
 * Display only. Nothing accumulated in these may reach picking, measurement,
 * terrain, export or claim evidence.
 */
import {
  CONSERVATIVE_LAYOUT,
  historyBytes,
  historyFits,
  type HistoryLayout,
} from '../streaming/historyBudget';

/** One allocated surface. The renderer's target type, narrowed to what is used. */
export interface HistorySurface {
  readonly label: string;
  readonly widthPx: number;
  readonly heightPx: number;
  dispose(): void;
}

/** Makes one surface. Supplied by the renderer; faked in tests. */
export type SurfaceFactory = (
  label: string,
  widthPx: number,
  heightPx: number,
  bytesPerPixel: number,
) => HistorySurface;

/** The three surfaces, allocated and released as one. */
export interface HistorySet {
  readonly colour: HistorySurface;
  readonly depth: HistorySurface;
  readonly support: HistorySurface;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly bytes: number;
  /** The device generation these were made on. */
  readonly deviceGeneration: number;
}

/** Why no history is allocated. */
export type HistoryRefusal =
  /** The backing store is degenerate: nothing to allocate for. */
  | 'no-viewport'
  /** The set would exceed the ceiling, so source rendering stands. */
  | 'over-ceiling';

/** Owns the history surfaces for one renderer, across resizes and epochs. */
export class HistoryTargets {
  private readonly _make: SurfaceFactory;
  private readonly _layout: HistoryLayout;
  private _set: HistorySet | null = null;
  private _refusal: HistoryRefusal | null = 'no-viewport';
  /** Counts clears, so the overlay can show how often history is thrown away. */
  private _clears = 0;
  /** Counts allocations, so a resize storm is visible rather than merely slow. */
  private _allocations = 0;

  constructor(make: SurfaceFactory, layout: HistoryLayout = CONSERVATIVE_LAYOUT) {
    this._make = make;
    this._layout = layout;
  }

  /** The current set, or null when none is allocated. */
  get set(): HistorySet | null {
    return this._set;
  }

  /** Why there is no set, or null when there is one. */
  get refusal(): HistoryRefusal | null {
    return this._refusal;
  }

  get clearCount(): number {
    return this._clears;
  }

  get allocationCount(): number {
    return this._allocations;
  }

  /**
   * Make the history match a backing store on a given device.
   *
   * A call at the size and generation already allocated is a no-op, so a render
   * loop may call this every frame. Anything else frees the old surfaces before
   * making new ones, because holding both at once is the moment a device is
   * most likely to refuse the second.
   *
   * The generation is why the size alone cannot decide this. A device lost and
   * remade at the same window size leaves every surface belonging to something
   * that no longer exists, and a check on size would call that a no-op and keep
   * them. Surfaces from a dead device are not a smaller problem than surfaces
   * of the wrong shape; they are the one the caller cannot see.
   */
  resize(widthPx: number, heightPx: number, deviceGeneration = 0): void {
    const w = Number.isFinite(widthPx) ? Math.max(0, Math.floor(widthPx)) : 0;
    const h = Number.isFinite(heightPx) ? Math.max(0, Math.floor(heightPx)) : 0;
    const gen = Number.isFinite(deviceGeneration) ? deviceGeneration : 0;
    if (
      this._set &&
      this._set.widthPx === w &&
      this._set.heightPx === h &&
      this._set.deviceGeneration === gen
    ) {
      return;
    }
    this.dispose();
    if (w === 0 || h === 0) {
      this._refusal = 'no-viewport';
      return;
    }
    if (!historyFits(w, h, this._layout)) {
      this._refusal = 'over-ceiling';
      return;
    }
    this._set = {
      colour: this._make('continuity-colour', w, h, this._layout.colour.bytesPerPixel),
      depth: this._make('continuity-depth', w, h, this._layout.depth.bytesPerPixel),
      support: this._make('continuity-support', w, h, this._layout.support.bytesPerPixel),
      widthPx: w,
      heightPx: h,
      bytes: historyBytes(w, h, this._layout),
      deviceGeneration: gen,
    };
    this._refusal = null;
    this._allocations += 1;
  }

  /**
   * Drop what the history holds without freeing it.
   *
   * What a display-state change needs. The surfaces are the right shape and the
   * pixels are stale, so the next sweep writes over them from its first phase.
   * Counted, because a history cleared every frame is accumulating nothing and
   * that should be visible rather than merely slow.
   */
  clear(): void {
    if (this._set === null) return;
    this._clears += 1;
  }

  /** Free every surface. Idempotent. */
  dispose(): void {
    if (this._set === null) return;
    this._set.colour.dispose();
    this._set.depth.dispose();
    this._set.support.dispose();
    this._set = null;
    this._refusal = 'no-viewport';
  }
}
