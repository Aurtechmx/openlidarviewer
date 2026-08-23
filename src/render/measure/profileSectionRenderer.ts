/**
 * profileSectionRenderer.ts
 *
 * Draw a profile cross-section onto a 2D canvas: one splat per observed
 * return, then the derived station series over the top.
 *
 * Two layers with different standing. The returns are measurements; the
 * station series is a reduction of them, one height per bin. The reduction
 * is useful to read a grade off, but it is not evidence, so it is drawn
 * after the returns, thinner, and at an alpha this module caps. A viewer
 * that lets a derived line sit over its own evidence at full weight invites
 * the line to be read as the data.
 *
 * Colour is not decided here. The caller passes a `Uint8Array` of RGB
 * triplets, one per drawn index, so whatever the colour mode resolved (class
 * palette, intensity ramp, source RGB, flat) is what reaches the canvas. A
 * renderer that reached for `classification` itself would silently override
 * the mode the user chose.
 *
 * No DOM is touched. The context is a structural interface, so a real
 * `CanvasRenderingContext2D` satisfies it and a recording double can be
 * substituted in a Node test.
 *
 * WHY BATCHED `fillRect` AND NOT `ImageData` / `putImageData`
 *
 *   `putImageData` costs one pass over the backing store per frame no matter
 *   how many points are drawn: a 1600 x 600 CSS plot at DPR 2 is 3200 x 1200
 *   device pixels, 3.84 M pixels, 15.4 MB of RGBA that has to be composed in
 *   JS and uploaded whole. A section corridor is not that large. The corridor
 *   is a band a few metres wide around one line, so a realistic accepted
 *   count is 1e3 to 1e5 returns, and the visible index list is smaller again
 *   once the caller decimates. At 1e5 splats, `fillRect` does 1e5 small
 *   rectangle fills against 3.84 M pixels of per-pixel bookkeeping, and the
 *   rectangles win by more than an order of magnitude.
 *
 *   `putImageData` also ignores the canvas transform, `globalAlpha`, and any
 *   clip, and it replaces rather than composites. Every one of those would
 *   have to be reimplemented by hand: the DPR scale, the splat radius (a
 *   splat wider than one pixel is a manual rasterisation), and the blend of
 *   overlapping returns. Each reimplementation is a place for the plot to
 *   disagree with the transform the rest of the profile uses.
 *
 *   The crossover is when drawn points approach the device-pixel count. A
 *   section that dense is already unreadable as splats and wants a density
 *   raster instead, which is a different product, not a faster path for this
 *   one.
 *
 * Per-point cost is kept to the fill itself: `fillStyle` is assigned only
 * when the triplet differs from the previous point's, and the CSS colour
 * strings are memoised per packed triplet, so a section coloured by class
 * pays a handful of style changes rather than one per return.
 */

import type { ProfileSectionPoints } from './profileSectionBuilder';
import type { ProfileSample } from './profileSampler';
import type { ProfileView, ProfileViewport } from './profileViewTransform';
import { profileDataToScreen, toDevicePixels } from './profileViewTransform';

/**
 * The 2D drawing operations this renderer uses, and nothing more.
 *
 * `fillStyle` and `strokeStyle` carry the DOM's own union so a real
 * `CanvasRenderingContext2D` is assignable; this module only ever writes
 * strings to them.
 */
export interface ProfileRenderingContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/**
 * The canvas the renderer owns.
 *
 * `setBackingSize` takes DEVICE pixels. Sizing the backing store is separated
 * from drawing because assigning a canvas's width or height clears it, so it
 * has to happen only when the size actually changed.
 */
export interface ProfileSurface {
  readonly ctx: ProfileRenderingContext;
  setBackingSize(deviceWidth: number, deviceHeight: number): void;
}

/**
 * Schedules one callback for the next frame.
 *
 * Passed in rather than reaching for `requestAnimationFrame` so a test can
 * drive the coalescing synchronously, and so a headless or worker host can
 * supply its own clock.
 */
export type ProfileFrameScheduler = (draw: () => void) => void;

/** What to draw. Every array is caller owned and is only read. */
export interface ProfileSectionScene {
  readonly points: ProfileSectionPoints;
  /** Indices into `points` to draw, in draw order. */
  readonly indices: Uint32Array;
  /** RGB triplets, one per entry of `indices`, NOT one per point index. */
  readonly colours: Uint8Array;
  /** The derived station series, or null to draw returns alone. */
  readonly stations?: readonly ProfileSample[] | null;
}

/** Splat and station weights, in CSS pixels. */
export interface ProfileSectionStyle {
  /** Side of the square splat, CSS pixels. */
  readonly pointSizePx: number;
  readonly pointAlpha: number;
  /** Station line width, CSS pixels. */
  readonly stationWidthPx: number;
  /** CSS colour of the station line. The caller owns it. */
  readonly stationColour: string;
  readonly stationAlpha: number;
}

/** A complete frame: what, seen how, at what weight. */
export interface ProfileSectionFrame {
  readonly scene: ProfileSectionScene;
  readonly view: ProfileView;
  readonly viewport: ProfileViewport;
  readonly style: ProfileSectionStyle;
}

/**
 * The most opaque the derived station line may be drawn.
 *
 * Clamped rather than trusted, because the layer ordering alone does not stop
 * a caller from handing in an opaque station line that hides the returns it
 * was derived from.
 */
export const MAX_STATION_ALPHA = 0.7;

/** Largest splat side accepted, CSS pixels. Beyond this the plot is blocks. */
const MAX_POINT_SIZE_PX = 64;

function finite(v: number): boolean {
  return Number.isFinite(v);
}

function clampAlpha(v: number, max: number): number {
  if (!finite(v)) return max;
  return Math.min(max, Math.max(0, v));
}

/** Device pixels per CSS pixel, with the same fallback the transform uses. */
function effectiveDpr(viewport: ProfileViewport): number {
  const d = viewport.devicePixelRatio;
  return finite(d) && d > 0 ? d : 1;
}

function positiveOr(v: number, fallback: number, max: number): number {
  if (!finite(v) || v <= 0) return fallback;
  return Math.min(max, v);
}

/** `rgb(r, g, b)` for a triplet, memoised on the packed 24-bit key. */
class ColourCache {
  private readonly cache = new Map<number, string>();

  get(r: number, g: number, b: number): string {
    const key = (r << 16) | (g << 8) | b;
    let css = this.cache.get(key);
    if (css === undefined) {
      css = `rgb(${r}, ${g}, ${b})`;
      this.cache.set(key, css);
    }
    return css;
  }
}

/**
 * Coalescing Canvas 2D renderer for one profile cross-section.
 *
 * `requestRender` marks the view dirty and asks the scheduler for a frame;
 * further requests before that frame fires are absorbed. `renderNow` draws
 * immediately and is what the scheduled callback ends up calling, so a host
 * that needs a synchronous draw (an export, a test) can call it directly.
 */
export class ProfileSectionRenderer {
  private readonly surface: ProfileSurface;
  private readonly schedule: ProfileFrameScheduler;
  private readonly colours = new ColourCache();
  private readonly scratch = new Float64Array(2);

  private frame: ProfileSectionFrame | null = null;
  private scheduled = false;
  private backingWidth = -1;
  private backingHeight = -1;
  private draws = 0;

  constructor(surface: ProfileSurface, schedule: ProfileFrameScheduler) {
    this.surface = surface;
    this.schedule = schedule;
  }

  /** Replace the frame. Does not draw; the caller invalidates explicitly. */
  setFrame(frame: ProfileSectionFrame): void {
    this.frame = frame;
  }

  /** True while a scheduled frame is still outstanding. */
  get pending(): boolean {
    return this.scheduled;
  }

  /** How many times {@link renderNow} has drawn. */
  get drawCount(): number {
    return this.draws;
  }

  /**
   * Mark dirty and ask for one frame.
   *
   * Several invalidations inside one frame produce one draw. The flag is
   * cleared before the draw runs, so an invalidation raised DURING a draw
   * schedules the next frame instead of being swallowed.
   */
  requestRender(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.renderNow();
    });
  }

  /** Draw the current frame immediately. */
  renderNow(): void {
    const frame = this.frame;
    if (frame === null) return;
    const { scene, view, viewport, style } = frame;
    const ctx = this.surface.ctx;
    const dpr = effectiveDpr(viewport);

    const cssWidth = positiveOr(viewport.width, 1, Number.MAX_SAFE_INTEGER);
    const cssHeight = positiveOr(viewport.height, 1, Number.MAX_SAFE_INTEGER);

    // The backing store is device pixels; everything below is CSS pixels
    // because the transform carries the ratio. Resizing clears the canvas, so
    // it is applied only on a real change.
    const deviceWidth = Math.max(1, Math.round(toDevicePixels(viewport, cssWidth)));
    const deviceHeight = Math.max(1, Math.round(toDevicePixels(viewport, cssHeight)));
    if (deviceWidth !== this.backingWidth || deviceHeight !== this.backingHeight) {
      this.surface.setBackingSize(deviceWidth, deviceHeight);
      this.backingWidth = deviceWidth;
      this.backingHeight = deviceHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    this.drawReturns(ctx, scene, view, viewport, style);
    // Derived after observed, always.
    this.drawStations(ctx, scene, view, viewport, style);

    ctx.globalAlpha = 1;
    this.draws++;
  }

  /**
   * One square splat per drawn index.
   *
   * The loop is bounded by the shorter of the index list and the colour
   * array, so a colour array that disagrees with the index list truncates
   * rather than reading past its end or pairing an index with a triplet that
   * was never supplied for it. `colours` is indexed by POSITION in `indices`,
   * so index `indices[k]` always takes triplet `k`.
   */
  private drawReturns(
    ctx: ProfileRenderingContext,
    scene: ProfileSectionScene,
    view: ProfileView,
    viewport: ProfileViewport,
    style: ProfileSectionStyle,
  ): void {
    const { points, indices, colours } = scene;
    const drawable = Math.min(indices.length, Math.floor(colours.length / 3));
    if (drawable <= 0) return;

    const size = positiveOr(style.pointSizePx, 1, MAX_POINT_SIZE_PX);
    const half = size / 2;
    ctx.globalAlpha = clampAlpha(style.pointAlpha, 1);

    const out = this.scratch;
    let lastCss = '';
    for (let k = 0; k < drawable; k++) {
      const i = indices[k]!;
      if (i >= points.count) continue;
      profileDataToScreen(view, viewport, points.chainage[i]!, points.height[i]!, out);
      const x = out[0]!;
      const y = out[1]!;
      // A non-finite coordinate, whether from a non-finite return or from a
      // non-finite view scale, is skipped. The loop is a counted for, so no
      // input can make it run longer than the index list.
      if (!finite(x) || !finite(y)) continue;
      const css = this.colours.get(colours[k * 3]!, colours[k * 3 + 1]!, colours[k * 3 + 2]!);
      if (css !== lastCss) {
        ctx.fillStyle = css;
        lastCss = css;
      }
      ctx.fillRect(x - half, y - half, size, size);
    }
  }

  /**
   * The derived station series, as straight segments between adjacent
   * samples, broken at every gap.
   *
   * A `NaN` height means the bin saw no returns. Joining across it would draw
   * a segment through ground nothing was measured on, and that segment would
   * be indistinguishable from measured ground. So a gap ends the current run
   * and the next finite sample starts a new one; the two are never joined.
   *
   * A run of one sample is left unstroked: a straight segment needs two ends,
   * and an isolated station has no segment to draw.
   */
  private drawStations(
    ctx: ProfileRenderingContext,
    scene: ProfileSectionScene,
    view: ProfileView,
    viewport: ProfileViewport,
    style: ProfileSectionStyle,
  ): void {
    const stations = scene.stations;
    if (stations == null || stations.length === 0) return;

    ctx.globalAlpha = clampAlpha(style.stationAlpha, MAX_STATION_ALPHA);
    ctx.strokeStyle = style.stationColour;
    ctx.lineWidth = positiveOr(style.stationWidthPx, 1, MAX_POINT_SIZE_PX);

    const out = this.scratch;
    let run = 0;
    for (let s = 0; s < stations.length; s++) {
      const sample = stations[s]!;
      const d = sample.distance;
      const h = sample.height;
      if (!finite(d) || !finite(h)) {
        if (run >= 2) ctx.stroke();
        run = 0;
        continue;
      }
      profileDataToScreen(view, viewport, d, h, out);
      const x = out[0]!;
      const y = out[1]!;
      if (!finite(x) || !finite(y)) {
        if (run >= 2) ctx.stroke();
        run = 0;
        continue;
      }
      if (run === 0) {
        ctx.beginPath();
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      run++;
    }
    if (run >= 2) ctx.stroke();
  }
}
