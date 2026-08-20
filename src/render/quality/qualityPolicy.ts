/**
 * qualityPolicy.ts
 *
 * One understandable performance dial. The viewer already carried several
 * independent speed/quality knobs — the streaming point budget, the concurrent
 * decode budget, the device-pixel-ratio ceiling, Eye Dome Lighting and
 * point-edge antialiasing — each with its own control in its own panel. This
 * module maps a single slider position onto all of them, plus an automatic
 * position derived from the device.
 *
 * Pure: no DOM, no three.js, no module state. Position in, settings out.
 *
 * ── SCOPE, and why it is drawn here ─────────────────────────────────────────
 * Everything this policy resolves is a DISPLAY or STREAMING setting. Nothing
 * it touches can move a measured number:
 *
 *   - the pixel-ratio ceiling decides how many pixels are shaded; figure and
 *     world-file export render at ratio 1 regardless (`Viewer._renderAtSize`);
 *   - Eye Dome Lighting and antialiasing are shading passes over the finished
 *     frame;
 *   - the streaming preset moves the resident-node budget, which changes how
 *     much of a streamed cloud is on screen at once.
 *
 * DELIBERATELY EXCLUDED: the static LOAD budget (`deviceCaps().renderBudget`,
 * passed to the loader as `budget`). It reads like a sibling of the streaming
 * point budget and is not one — it voxel-reduces the decoded cloud BEFORE the
 * cloud exists, and terrain analysis, measurement and export all read that same
 * reduced cloud. Driving it from a slider would silently change a computed
 * quantity, so it stays where it is, owned by the device profile alone.
 *
 * ── BOUNDS AND MONOTONICITY ─────────────────────────────────────────────────
 * Position runs `[QUALITY_MIN, QUALITY_MAX]` = `[0, 100]`; anything outside,
 * and any non-finite value, clamps into that range. The range is divided into
 * `QUALITY_STOPS.length` (5) equal steps, so 0 is the Speed end, 50 the
 * midpoint, and 100 the Quality end.
 *
 * Every resolved field is MONOTONIC NON-DECREASING in position, and
 * `qualityPolicyIsMonotonic()` proves it over the whole table:
 *
 *   step               0        1        2         3         4
 *   streamingQuality   low      low      balanced  balanced  high
 *   maxPixelRatio      1.00     1.25     1.50      1.50      2.00
 *   edlEnabled         off      off      off       on        on
 *   antialiasing       off      on       on        on        on
 *
 * `streamingPointBudget` and `maxConcurrentDecodes` come from the existing
 * `streamingBudgets()` table, which is itself non-decreasing across
 * low → balanced → high on both the desktop and the mobile row.
 */

import type { DeviceTier } from '../deviceProfile';
import { edlDefaultEnabled, type RenderBackend } from '../edl';
import {
  streamingBudgets,
  type StreamingQuality,
} from '../streaming/streamingBudget';
import {
  clampPixelRatioCeiling,
  MAX_PIXEL_RATIO_DEFAULT,
} from './pixelRatioCeiling';

/** Slider lower bound — the Speed end. */
export const QUALITY_MIN = 0;

/** Slider upper bound — the Quality end. */
export const QUALITY_MAX = 100;

/** What the device can be told about itself before the first frame. */
export interface QualityDevice {
  /** Capability tier from `deviceProfile.deviceTier()`. */
  readonly tier: DeviceTier;
  /** True on phone-class devices. */
  readonly isMobile: boolean;
  /** The backend the renderer actually settled on. */
  readonly backend: RenderBackend;
}

/** The display + streaming settings a slider position resolves to. */
export interface QualitySettings {
  /** The position these settings came from, after clamping. */
  readonly position: number;
  /** The existing streaming preset (`StreamingPanel`'s Quality chips). */
  readonly streamingQuality: StreamingQuality;
  /** Resident point budget the preset implies on this device. Derived. */
  readonly streamingPointBudget: number;
  /** Concurrent decode budget the preset implies on this device. Derived. */
  readonly maxConcurrentDecodes: number;
  /** Ceiling applied to `window.devicePixelRatio`. */
  readonly maxPixelRatio: number;
  /** Eye Dome Lighting depth shading. */
  readonly edlEnabled: boolean;
  /** Point-edge antialiasing (alpha-to-coverage). */
  readonly antialiasing: boolean;
}

/** The fields an Advanced control may pin independently of the slider. */
export type QualityOverrides = Partial<
  Pick<
    QualitySettings,
    'streamingQuality' | 'maxPixelRatio' | 'edlEnabled' | 'antialiasing'
  >
>;

/** What the user has chosen: automatic, or a position plus any pinned fields. */
export interface QualityPreference {
  /** True when the position follows the device rather than the user. */
  readonly auto: boolean;
  /** The user's slider position. Ignored while `auto` is true. */
  readonly position: number;
  /** Fields pinned from the Advanced disclosure. */
  readonly overrides: QualityOverrides;
}

/** One step of the slider: the fields that do not depend on the device. */
interface QualityStop {
  readonly label: string;
  readonly streamingQuality: StreamingQuality;
  readonly maxPixelRatio: number;
  readonly edlEnabled: boolean;
  readonly antialiasing: boolean;
}

/**
 * The five stops, Speed → Quality.
 *
 * Step 2 is the midpoint and reproduces the viewer's historical defaults on a
 * WebGL 2 desktop and on a capable phone; step 3 reproduces them on a WebGPU
 * desktop, which is where `edlDefaultEnabled` already turned Eye Dome Lighting
 * on. Step 0 reproduces the old low-tier degraded path (no EDL, no
 * antialiasing) and additionally drops the pixel-ratio ceiling and the
 * streaming preset, which had no low-tier handling before.
 */
export const QUALITY_STOPS: readonly QualityStop[] = Object.freeze([
  { label: 'Speed', streamingQuality: 'low', maxPixelRatio: 1, edlEnabled: false, antialiasing: false },
  { label: 'Faster', streamingQuality: 'low', maxPixelRatio: 1.25, edlEnabled: false, antialiasing: true },
  { label: 'Balanced', streamingQuality: 'balanced', maxPixelRatio: MAX_PIXEL_RATIO_DEFAULT, edlEnabled: false, antialiasing: true },
  { label: 'Sharper', streamingQuality: 'balanced', maxPixelRatio: MAX_PIXEL_RATIO_DEFAULT, edlEnabled: true, antialiasing: true },
  { label: 'Quality', streamingQuality: 'high', maxPixelRatio: 2, edlEnabled: true, antialiasing: true },
]);

/** Width of one step on the `[0, 100]` scale. */
const STEP_WIDTH = (QUALITY_MAX - QUALITY_MIN) / QUALITY_STOPS.length;

/** Clamp any number — including `NaN` — into `[QUALITY_MIN, QUALITY_MAX]`. */
export function clampQualityPosition(position: number): number {
  if (!Number.isFinite(position)) return midQualityPosition();
  return Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, position));
}

/** The exact midpoint of the scale — the Balanced stop. */
export function midQualityPosition(): number {
  return (QUALITY_MIN + QUALITY_MAX) / 2;
}

/**
 * Which stop a position falls in. Equal-width buckets, with the top bucket
 * closed so `QUALITY_MAX` itself lands on the last stop rather than one past it.
 */
export function qualityStepFor(position: number): number {
  const clamped = clampQualityPosition(position);
  const step = Math.floor((clamped - QUALITY_MIN) / STEP_WIDTH);
  return Math.min(QUALITY_STOPS.length - 1, step);
}

/** The short label for a position — what the control shows under the slider. */
export function qualityLabelFor(position: number): string {
  return QUALITY_STOPS[qualityStepFor(position)].label;
}

/**
 * Resolve a slider position against a device.
 *
 * The streaming budgets are read from the existing `streamingBudgets()` table
 * rather than restated here, so the master control and the Streaming panel's
 * Quality chips can never disagree about what "balanced" means.
 */
export function qualitySettingsFor(
  position: number,
  device: QualityDevice,
): QualitySettings {
  const clamped = clampQualityPosition(position);
  const stop = QUALITY_STOPS[qualityStepFor(clamped)];
  const budgets = streamingBudgets(stop.streamingQuality, device.isMobile);
  return {
    position: clamped,
    streamingQuality: stop.streamingQuality,
    streamingPointBudget: budgets.pointBudget,
    maxConcurrentDecodes: budgets.maxConcurrentDecodes,
    maxPixelRatio: stop.maxPixelRatio,
    edlEnabled: stop.edlEnabled,
    antialiasing: stop.antialiasing,
  };
}

/**
 * The position Auto picks for a device.
 *
 * A `low` tier lands on the Speed end, which is the degraded path the shell
 * used to apply by hand (Eye Dome Lighting and antialiasing off). Everything
 * else lands on the midpoint, or one step above it when the backend already
 * wanted Eye Dome Lighting on — so Auto reproduces the viewer's existing boot
 * state instead of quietly changing it.
 */
export function autoQualityPosition(device: QualityDevice): number {
  if (device.tier === 'low') return QUALITY_MIN;
  const mid = midQualityPosition();
  return edlDefaultEnabled(device.backend, device.isMobile) ? mid + STEP_WIDTH : mid;
}

/**
 * The settings a preference resolves to on a device: the automatic or the
 * user's position, with any pinned Advanced fields laid over the top.
 *
 * Overrides are applied AFTER the position, so pinning one field never moves
 * the others, and the derived streaming budgets follow a pinned preset rather
 * than the slider's.
 */
export function resolveQualitySettings(
  preference: QualityPreference,
  device: QualityDevice,
): QualitySettings {
  const position = preference.auto
    ? autoQualityPosition(device)
    : clampQualityPosition(preference.position);
  const base = qualitySettingsFor(position, device);
  const overrides = preference.overrides;
  const streamingQuality = overrides.streamingQuality ?? base.streamingQuality;
  const budgets =
    streamingQuality === base.streamingQuality
      ? { pointBudget: base.streamingPointBudget, maxConcurrentDecodes: base.maxConcurrentDecodes }
      : streamingBudgets(streamingQuality, device.isMobile);
  return {
    position,
    streamingQuality,
    streamingPointBudget: budgets.pointBudget,
    maxConcurrentDecodes: budgets.maxConcurrentDecodes,
    maxPixelRatio:
      overrides.maxPixelRatio === undefined
        ? base.maxPixelRatio
        : clampPixelRatioCeiling(overrides.maxPixelRatio),
    edlEnabled: overrides.edlEnabled ?? base.edlEnabled,
    antialiasing: overrides.antialiasing ?? base.antialiasing,
  };
}

/** Rank of a streaming preset, so monotonicity can be asserted over it. */
const STREAMING_RANK: Readonly<Record<StreamingQuality, number>> = Object.freeze({
  low: 0,
  balanced: 1,
  high: 2,
});

/**
 * Whether every field is non-decreasing from the Speed end to the Quality end
 * on a given device. The control has one job — "right is better looking, left
 * is faster" — and a table edit that broke it would make the slider lie.
 */
export function qualityPolicyIsMonotonic(device: QualityDevice): boolean {
  let previous: QualitySettings | null = null;
  for (let step = 0; step < QUALITY_STOPS.length; step += 1) {
    const current = qualitySettingsFor(step * STEP_WIDTH, device);
    if (previous) {
      if (STREAMING_RANK[current.streamingQuality] < STREAMING_RANK[previous.streamingQuality]) return false;
      if (current.streamingPointBudget < previous.streamingPointBudget) return false;
      if (current.maxConcurrentDecodes < previous.maxConcurrentDecodes) return false;
      if (current.maxPixelRatio < previous.maxPixelRatio) return false;
      if (Number(current.edlEnabled) < Number(previous.edlEnabled)) return false;
      if (Number(current.antialiasing) < Number(previous.antialiasing)) return false;
    }
    previous = current;
  }
  return true;
}
