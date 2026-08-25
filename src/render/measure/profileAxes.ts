/**
 * profileAxes.ts
 *
 * Tick placement and axis titling for a 2D profile cross-section: where the
 * major and minor rules fall, what each tick reads, and what each axis is
 * called. Pure. No DOM, no canvas, no renderer.
 *
 * Two rules govern the numbers here.
 *
 * A tick is an exact multiple of its step. A step is a leading digit of 1, 2
 * or 5 times a power of ten, so every multiple of it is exact at `-exponent`
 * decimal places; each tick is built as `index × step` and then snapped to
 * that many places, which is what keeps a label reading `12` and `0.3`
 * rather than `12.000000000000002`.
 *
 * An axis title states no more about the vertical reference than the scan
 * supports. `heightLabel` in `geo/height.ts` owns that wording, so a height
 * with no declared datum reads "Height (datum unknown)" on this axis for the
 * same reason it does in the point inspector, and "Elevation" appears only
 * where an orthometric datum was declared. A local frame reads "Local
 * height", the word the profile PDF sheet and the Measurements panel already
 * print for a section with no datum.
 *
 * Tick labels are bare numbers and the unit sits in the axis title: an axis
 * holds one unit down its whole column, so the per-value unit banding in
 * `format.ts` (cm → m → km as a magnitude grows) does not apply to a tick.
 * The horizontal and vertical units of a profile can differ, so each title
 * carries its own suffix.
 */

import type { UnitSystem } from './types';
import type { ProfileStation } from './profileStations';
import { formatStation } from './profileSummary';
import { displayDecimals } from './format';
import { heightLabel } from '../../geo/height';
import type { VerticalReference } from '../../geo/height';
import { profileVisibleBounds, profileDataToScreen } from './profileViewTransform';
import type {
  ProfileView,
  ProfileViewport,
  ProfileUnitContext,
} from './profileViewTransform';

// ─────────────────────────────────────────────────────────────────────────────
// Tick spacing
// ─────────────────────────────────────────────────────────────────────────────

/** Leading digits a step may take, ascending. */
const NICE_MANTISSAS: readonly number[] = [1, 2, 5];

/** Smallest step the generator will produce, and the decimal ceiling it implies. */
const MIN_STEP = 1e-20;
const MAX_DECIMALS = 20;

/** Hard bound on the emitted tick count, so no input can produce an unbounded list. */
export const MAX_AXIS_TICKS = 512;

/** Bounds on the requested tick count. */
export const MAX_TARGET_TICKS = 100;
export const DEFAULT_TARGET_TICKS = 6;

/** A resolved major-tick scale for one axis. */
export interface AxisTicks {
  /** Spacing between adjacent major ticks. Always finite and > 0. */
  readonly step: number;
  /** Major tick values, ascending. Never empty; every entry is finite. */
  readonly values: readonly number[];
  /** Decimal places a label needs to print any multiple of `step` exactly. */
  readonly decimals: number;
  /** Minor divisions per major step. See {@link minorTickStep}. */
  readonly minorPerMajor: number;
}

interface NiceStep {
  readonly step: number;
  readonly mantissa: number;
  readonly exponent: number;
}

/**
 * The smallest 1/2/5 × 10ⁿ step that is at least `raw`.
 *
 * The `1 + 1e-12` slack absorbs the `log10`/`pow` round trip, so a raw step
 * that already IS 2 × 10ⁿ takes mantissa 2 rather than climbing to 5. A frac
 * that lands at or above 10 (which the round trip can produce for an exact
 * power of ten) falls through to the next decade, still a valid step.
 */
function niceStepAtLeast(raw: number): NiceStep {
  const bounded = Number.isFinite(raw) && raw > MIN_STEP ? raw : MIN_STEP;
  const exponent = Math.floor(Math.log10(bounded));
  const frac = bounded / Math.pow(10, exponent);
  for (const m of NICE_MANTISSAS) {
    if (frac <= m * (1 + 1e-12)) {
      return { step: m * Math.pow(10, exponent), mantissa: m, exponent };
    }
  }
  const up = exponent + 1;
  return { step: Math.pow(10, up), mantissa: 1, exponent: up };
}

/**
 * Minor divisions per major step, keyed on the step's leading digit: a 1 step
 * splits into 5 (0.2 each), a 2 step into 4 (0.5 each), a 5 step into 5 (1
 * each). Every rule puts the minor lines on a round decimal fraction of the
 * major step, which is what a reader recovers at a glance; splitting a 2 step
 * into 5 would place lines at 0.4, and a 1 step into 4 at 0.25.
 */
function minorsFor(mantissa: number): number {
  return mantissa === 2 ? 4 : 5;
}

/** Snap to `decimals` places, so the value is an exact multiple of its step. */
function snap(v: number, decimals: number): number {
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(decimals));
}

/**
 * Index of the first (`up`) or last (`down`) multiple of `step` at a bound.
 *
 * A bound that IS a multiple can land a hair either side of the integer once
 * divided, so the comparison carries a relative tolerance rather than an
 * absolute one: at an index of 5 × 10¹⁴ an absolute epsilon is below the
 * spacing of the doubles involved and would never fire.
 */
function boundIndex(v: number, step: number, dir: 'up' | 'down'): number {
  const q = v / step;
  if (!Number.isFinite(q)) return Number.NaN;
  const tol = 1e-9 * Math.max(1, Math.abs(q));
  return dir === 'up' ? Math.ceil(q - tol) : Math.floor(q + tol);
}

function clampTarget(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TARGET_TICKS;
  return Math.min(MAX_TARGET_TICKS, Math.max(1, Math.trunc(n)));
}

/**
 * Major ticks across `[min, max]` at roughly `targetCount` of them.
 *
 * Total on degenerate input: non-finite bounds read as 0, an inverted range is
 * taken as its ordered pair, and a zero-width range still yields one tick so
 * the axis remains drawable. Every returned tick is finite and an exact
 * multiple of `step`; every tick lies inside the range whenever the range has
 * width.
 */
export function axisTicks(min: number, max: number, targetCount: number): AxisTicks {
  const a = Number.isFinite(min) ? min : 0;
  const b = Number.isFinite(max) ? max : 0;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const target = clampTarget(targetCount);
  const span = hi - lo;
  const magnitude = Math.max(Math.abs(lo), Math.abs(hi));
  // Doubles near a magnitude are spaced about EPSILON × magnitude apart, so a
  // step below that cannot separate two ticks and would emit a duplicate list.
  const floorStep = Math.max(MIN_STEP, magnitude * Number.EPSILON * 8);
  const raw = span > 0 ? span / target : magnitude > 0 ? magnitude / target : 1;
  const nice = niceStepAtLeast(Math.max(raw, floorStep));
  const decimals = Math.min(MAX_DECIMALS, Math.max(0, -nice.exponent));
  const step = nice.step;

  const first = boundIndex(lo, step, 'up');
  const last = boundIndex(hi, step, 'down');
  const values: number[] = [];
  if (Number.isFinite(first) && Number.isFinite(last) && last >= first) {
    const count = Math.min(last - first + 1, MAX_AXIS_TICKS);
    for (let i = 0; i < count; i++) values.push(snap((first + i) * step, decimals));
  } else {
    // Nothing lands inside, which a zero-width range produces whenever its
    // value is not itself a multiple. One tick still has to exist for the axis
    // to be drawable, and the nearest multiple keeps that tick exact.
    const q = lo / step;
    values.push(snap((Number.isFinite(q) ? Math.round(q) : 0) * step, decimals));
  }
  return { step, values, decimals, minorPerMajor: minorsFor(nice.mantissa) };
}

/**
 * Spacing of the minor rule. One more decimal place than the major step
 * covers every division the {@link minorsFor} rule produces: a fifth of
 * 1 × 10ⁿ is 2 × 10ⁿ⁻¹, a quarter of 2 × 10ⁿ is 5 × 10ⁿ⁻¹, and a fifth of
 * 5 × 10ⁿ is 1 × 10ⁿ.
 */
export function minorTickStep(ticks: AxisTicks): number {
  return ticks.step / ticks.minorPerMajor;
}

/** Minor tick values across `[min, max]`, excluding the major ones. */
export function minorTickValues(ticks: AxisTicks, min: number, max: number): number[] {
  const a = Number.isFinite(min) ? min : 0;
  const b = Number.isFinite(max) ? max : 0;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const step = minorTickStep(ticks);
  const decimals = Math.min(MAX_DECIMALS, ticks.decimals + 1);
  const first = boundIndex(lo, step, 'up');
  const last = boundIndex(hi, step, 'down');
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
  const count = Math.min(last - first + 1, MAX_AXIS_TICKS);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const index = first + i;
    if (index % ticks.minorPerMajor === 0) continue;
    out.push(snap(index * step, decimals));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick labels
// ─────────────────────────────────────────────────────────────────────────────

/** A non-finite readout, the same em dash the measurement formatters print. */
const NO_VALUE = '—';

/**
 * One tick as text, fixed to the step's own decimal count. The count comes
 * from the step rather than from the value, so a column of labels shares one
 * decimal place and no entry carries binary residue.
 */
export function formatAxisValue(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  const places = Number.isFinite(decimals)
    ? Math.min(MAX_DECIMALS, Math.max(0, Math.trunc(decimals)))
    : 0;
  return value.toFixed(places);
}

/** Plain chainage labels: the tick values as written, unit carried by the title. */
export function chainageTickLabels(ticks: AxisTicks): string[] {
  return ticks.values.map((v) => formatAxisValue(v, ticks.decimals));
}

/**
 * Civil stationing labels for the chainage axis, or null when they cannot be
 * stated.
 *
 * `formatStation` reads metres, and a profile's chainage is in the scan's own
 * horizontal unit, so the conversion needs `horizontalToMetres`. Where that is
 * unknown the station notation would name a kilometre boundary the data never
 * established, and null is returned instead.
 */
export function stationTickLabels(
  ticks: AxisTicks,
  units: ProfileUnitContext,
  system: UnitSystem,
): string[] | null {
  const f = units.horizontalToMetres;
  if (f == null || !Number.isFinite(f) || f <= 0) return null;
  return ticks.values.map((v) => formatStation(v * f, system));
}

/**
 * Station labels for the markers `stationsAlongLine` emitted, in the order it
 * emitted them. Reads the same chainage field the sampler and the PDF read, so
 * an axis marker and a station-table row cannot name one position differently.
 */
export function stationMarkerLabels(
  stations: ReadonlyArray<ProfileStation>,
  metresPerUnit: number,
  system: UnitSystem,
): string[] {
  const f = Number.isFinite(metresPerUnit) && metresPerUnit > 0 ? metresPerUnit : 1;
  return stations.map((s) => formatStation(s.chainage * f, system));
}

/**
 * The visible span of an axis as a readout, e.g. "247.53 m". A span is a
 * magnitude rather than a tick, so its decimals follow the stack's
 * significant-figure policy in {@link displayDecimals} instead of the step.
 */
export function axisSpanCaption(span: number, unitSuffix: string | null): string {
  if (!Number.isFinite(span)) return NO_VALUE;
  const text = span.toFixed(displayDecimals(span, 0, 6));
  const u = unitSuffix?.trim();
  return u ? `${text} ${u}` : text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Axis titles
// ─────────────────────────────────────────────────────────────────────────────

/** The chainage axis word. */
export const CHAINAGE_AXIS_WORD = 'Chainage';

/**
 * The height word for a section whose coordinates are in the dataset's own
 * local frame. The profile PDF sheet and the Measurements panel station table
 * already print this for a section with no datum.
 */
export const PROFILE_LOCAL_HEIGHT_WORD = 'Local height';

/**
 * The word this profile's height axis uses.
 *
 * Every case but the local frame defers to `heightLabel`, so an orthometric
 * datum reads "Elevation", a WGS 84 ellipsoidal height reads "Ellipsoidal
 * height", and an absent or unrecognised datum reads "Height (datum unknown)".
 * A local frame takes the profile surfaces' own word instead of the generic
 * "Height (local frame)".
 */
export function profileHeightWord(reference: VerticalReference): string {
  return reference === 'local' ? PROFILE_LOCAL_HEIGHT_WORD : heightLabel(reference);
}

/**
 * `word (unit)`, the composition the station table's column headings use. An
 * absent or blank unit leaves the word alone rather than printing empty
 * brackets.
 */
export function axisTitle(word: string, unitSuffix: string | null): string {
  const u = unitSuffix?.trim();
  return u ? `${word} (${u})` : word;
}

/** Title for the chainage axis in its own horizontal unit. */
export function chainageAxisTitle(unitSuffix: string | null): string {
  return axisTitle(CHAINAGE_AXIS_WORD, unitSuffix);
}

/** Title for the height axis in its own vertical unit. */
export function heightAxisTitle(
  reference: VerticalReference,
  unitSuffix: string | null,
): string {
  return axisTitle(profileHeightWord(reference), unitSuffix);
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembled axes
// ─────────────────────────────────────────────────────────────────────────────

/** What the caller states about the section being drawn. */
export interface ProfileAxesConfig {
  /** Vertical reference of the section's heights. */
  readonly reference: VerticalReference;
  /** Unit suffix for the chainage axis, e.g. "m". Null when unknown. */
  readonly horizontalUnit: string | null;
  /** Unit suffix for the height axis, e.g. "m". Null when unknown. */
  readonly verticalUnit: string | null;
  /** Metres per data unit on each axis, for the station notation. */
  readonly units: ProfileUnitContext;
  /** Civil stationing on the chainage axis instead of plain numbers. */
  readonly stationing?: boolean;
  readonly unitSystem?: UnitSystem;
  readonly targetXTicks?: number;
  readonly targetYTicks?: number;
}

/** One drawable axis: its ticks, its labels, its title, its screen positions. */
export interface ProfileAxis {
  readonly ticks: AxisTicks;
  readonly labels: readonly string[];
  /** Screen position of each tick, CSS pixels from the top left. */
  readonly pixels: readonly number[];
  readonly minorPixels: readonly number[];
  readonly title: string;
}

/** Both axes of a profile view. */
export interface ProfileAxesModel {
  readonly x: ProfileAxis;
  readonly y: ProfileAxis;
}

/**
 * Build both axes for the region a view currently shows.
 *
 * Chainage ticks fall on the horizontal, height ticks on the vertical, and
 * each tick's pixel position comes from the same transform the section
 * geometry is drawn with, so a rule and the points beside it cannot drift.
 * A stationing request with no horizontal metres scale falls back to plain
 * chainage labels rather than to a station notation the units cannot support.
 */
export function profileAxes(
  view: ProfileView,
  viewport: ProfileViewport,
  config: ProfileAxesConfig,
): ProfileAxesModel {
  const bounds = profileVisibleBounds(view, viewport);
  const system: UnitSystem = config.unitSystem ?? 'metric';

  const xTicks = axisTicks(
    bounds.minChainage,
    bounds.maxChainage,
    config.targetXTicks ?? DEFAULT_TARGET_TICKS,
  );
  const yTicks = axisTicks(
    bounds.minHeight,
    bounds.maxHeight,
    config.targetYTicks ?? DEFAULT_TARGET_TICKS,
  );

  const stationLabels = config.stationing
    ? stationTickLabels(xTicks, config.units, system)
    : null;

  const scratch = new Float64Array(2);
  const xAt = (chainage: number): number => {
    profileDataToScreen(view, viewport, chainage, view.centreHeight, scratch);
    return scratch[0]!;
  };
  const yAt = (height: number): number => {
    profileDataToScreen(view, viewport, view.centreChainage, height, scratch);
    return scratch[1]!;
  };

  return {
    x: {
      ticks: xTicks,
      labels: stationLabels ?? chainageTickLabels(xTicks),
      pixels: xTicks.values.map(xAt),
      minorPixels: minorTickValues(xTicks, bounds.minChainage, bounds.maxChainage).map(xAt),
      title: chainageAxisTitle(config.horizontalUnit),
    },
    y: {
      ticks: yTicks,
      labels: yTicks.values.map((v) => formatAxisValue(v, yTicks.decimals)),
      pixels: yTicks.values.map(yAt),
      minorPixels: minorTickValues(yTicks, bounds.minHeight, bounds.maxHeight).map(yAt),
      title: heightAxisTitle(config.reference, config.verticalUnit),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fitting labels along an axis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Width one character of a label occupies, as a fraction of the font size.
 *
 * A bound, not a measurement, and rounded the only way that fails safe.
 * Overstating a label's width can only drop a label that would have fitted,
 * which is legible. Understating it lets two labels overlap, which is not.
 * Measured in a browser at the axis font, the widest case is a short label of
 * wide digits: `88 m` runs 6.74px at 11px, or 0.613em. Short labels are the
 * wide ones per character, so a mean taken over long labels understates
 * exactly the ones at risk.
 *
 * Expressed per em rather than per pixel so it follows the font size instead
 * of silently going stale when the axis type scale changes.
 */
export const AXIS_LABEL_CHAR_EM = 0.62;

/**
 * Least clear space between two kept labels, in CSS pixels.
 *
 * Clear space, not centre distance: two labels that merely fail to overlap
 * still read as one run of digits, which is the failure being avoided.
 */
export const AXIS_LABEL_MIN_GAP_PX = 8;

/** Width a label occupies at `fontPx`, erring wide. */
export function axisLabelWidth(label: string, fontPx: number): number {
  const size = Number.isFinite(fontPx) && fontPx > 0 ? fontPx : 0;
  return label.length * size * AXIS_LABEL_CHAR_EM;
}

/**
 * How a renderer places the labels at the two ends of the strip.
 *
 * `centred` draws every label centred on its tick, so an end label can hang
 * past the strip and is dropped rather than clipped: half a number at the edge
 * states a value the axis is not showing.
 *
 * `pulled-in` is for a renderer that anchors the ends inside the strip, the
 * first flush left and the last flush right. Nothing can overhang, so the ends
 * are kept and they carry the axis range, which is what a reader takes from an
 * axis first. The two are not interchangeable: judging a pulled-in last label
 * as though it were centred puts half its box past the end of the strip and
 * drops it, and judging a centred one as pulled-in lets it overhang.
 */
export type AxisLabelEnds = 'centred' | 'pulled-in';

/** What the fitter is told about the strip the labels are drawn in. */
export interface AxisLabelFit {
  /** Label text, one per tick, in the tick order. */
  readonly labels: readonly string[];
  /** Centre of each label along the strip, CSS pixels. */
  readonly pixels: readonly number[];
  /** Extent of the strip, CSS pixels. A smaller value is the safe direction. */
  readonly containerPx: number;
  /** Font size the labels will be drawn at, CSS pixels. */
  readonly fontPx: number;
  /**
   * Extent of one label ACROSS the strip rather than along it. Absent, the
   * text width is used, which is the horizontal axis; a vertical axis passes
   * the line height, because its labels are stacked and their widths never
   * collide with one another.
   */
  readonly extentPx?: (label: string) => number;
  /** How the ends are anchored. Defaults to `centred`. */
  readonly ends?: AxisLabelEnds;
}

/**
 * Which labels may be drawn without two of them touching.
 *
 * WHY NOT EVERY SECOND ONE. Index-based thinning assumes the labels are evenly
 * spaced in pixels and equally wide, and an axis satisfies neither: the
 * transform that places a tick is not required to be uniform across the
 * visible span, and `-1250.5` is more than twice the width of `0`. Thinning by
 * index drops readable labels in the sparse part of an axis while leaving the
 * crowded part still overlapping, which is the worst of both. This walks the
 * strip and keeps a label only when the space it needs is actually free.
 *
 * Fitting from one end and never backtracking: the first label that fits is
 * kept, and each later one only when its space is still free.
 *
 * Returns one flag per input label, in the input order.
 */
export function fitAxisLabels(fit: AxisLabelFit): boolean[] {
  const n = Math.min(fit.labels.length, fit.pixels.length);
  const keep = new Array<boolean>(fit.labels.length).fill(false);
  if (n === 0) return keep;
  const font = Number.isFinite(fit.fontPx) && fit.fontPx > 0 ? fit.fontPx : 0;
  // A container of unknown or negative extent reads as zero, which keeps only
  // the labels that need no room at all. Too narrow is the safe direction.
  const container = Number.isFinite(fit.containerPx) && fit.containerPx > 0 ? fit.containerPx : 0;
  const extent = fit.extentPx ?? ((label: string) => axisLabelWidth(label, font));
  const pulledIn = fit.ends === 'pulled-in';

  // Strip order, not tick order: a vertical axis places its first tick at the
  // BOTTOM of the strip, and a walk in tick order would compare a label with
  // one that is not its neighbour on screen.
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(fit.pixels[i]!)) order.push(i);
  order.sort((a, b) => fit.pixels[a]! - fit.pixels[b]!);
  const firstIdx = order[0];
  const lastIdx = order[order.length - 1];

  /** The span a label occupies, given how its end is anchored. */
  const spanOf = (i: number): readonly [number, number] => {
    const w = extent(fit.labels[i] ?? '');
    if (pulledIn && i === firstIdx) return [0, w];
    if (pulledIn && i === lastIdx) return [container - w, container];
    const half = w / 2;
    return [fit.pixels[i]! - half, fit.pixels[i]! + half];
  };

  // A pulled-in strip reserves its far end before the walk, so an interior
  // label cannot take the space the range label needs. The near end is the
  // walk's own starting point and needs no reservation.
  let reservedFrom = Infinity;
  if (pulledIn && order.length > 1) {
    const [lo, hi] = spanOf(lastIdx);
    // The two ends can collide on a short strip. The far end wins, because a
    // reader scanning for the extent looks at the end of the axis.
    if (lo >= 0 && hi <= container) {
      keep[lastIdx] = true;
      reservedFrom = lo;
    }
  }

  let occupiedTo = -Infinity;
  let anyKept = false;
  for (const i of order) {
    if (i === lastIdx && keep[lastIdx]) continue;
    const [start, end] = spanOf(i);
    if (start < 0 || end > container) continue;
    if (anyKept && start < occupiedTo + AXIS_LABEL_MIN_GAP_PX) continue;
    if (end > reservedFrom - AXIS_LABEL_MIN_GAP_PX) continue;
    keep[i] = true;
    anyKept = true;
    occupiedTo = end;
  }
  return keep;
}
