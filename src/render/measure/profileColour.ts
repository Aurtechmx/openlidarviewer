/**
 * profileColour.ts
 *
 * Colour the returns of a profile cross-section, and say what the colours
 * mean.
 *
 * The 2D section is a second view of the same returns the 3D scene holds, so
 * it colours them through the SAME primitives: `colorByScalar` /
 * `colorByIntensity` for the ramped scalars, `colorByClassification` and
 * `classColor` for the ASPRS classes, `computeScalarRange` for the percentile
 * window. A section that painted its own ramp would drift from the scene it
 * is a section of, and a legend swatch would stop matching the pixels.
 *
 * Four rules the section adds on top of those primitives:
 *
 *   1. UNORDERED IDS NEVER GET A RAMP. `colorModes.ts` refuses `pointSourceId`
 *      a colour mode outright: the id is absent from its `ColorMode` union, so
 *      no ramp signature in that module accepts one. The same refusal is
 *      spelled here as a type: {@link ProfileRampMode} lists the four ordered
 *      scalars, {@link profileRampPalette} is the only door to a ramp, and it
 *      accepts nothing else. Point source id and source layer are
 *      {@link ProfileCategoricalMode}s and take the qualitative palette.
 *      Flight line 7 is not "more" than flight line 3, and a sequential ramp
 *      would claim it is.
 *
 *   2. A MISSING ATTRIBUTE IS NOT A ZERO. A section can mix a source that
 *      carries intensity with one that does not, and `channelPresence` records
 *      that per point. A point whose bit is clear takes
 *      {@link PROFILE_UNKNOWN_COLOUR} and is counted into the legend's unknown
 *      bucket. It is never fed to the ramp, and it never reaches the range
 *      computation, so an absent intensity cannot pull the window down to 0
 *      nor read as a measured dark return.
 *
 *   3. A HEIGHT RANGE IS NAMED. Section-local, active layer, and project
 *      shared answer different questions — the shape of this cut, this layer
 *      against itself, this cut against the whole project — and produce
 *      different pictures from the same points. The caller asks for one and
 *      the legend reports which was used, so a reader is never left to guess
 *      what the ramp endpoints refer to.
 *
 *   4. A MODE WITH TOO LITTLE BEHIND IT IS NOT OFFERED. See
 *      {@link profileModeAvailability}.
 *
 * Output goes into a caller-owned `Uint8Array` of RGB triplets, one triplet
 * per displayed index. Per call the module allocates a scratch value buffer, a
 * scratch slot buffer, and the legend; nothing is allocated per point.
 *
 * Pure — no DOM, no canvas — so the rules are testable without a renderer.
 */

import type { ElevationPalette } from '../colorModes';
import {
  DEFAULT_ELEVATION_PALETTE,
  DEFAULT_SCALAR_PALETTE,
  classColor,
  colorblindSafeClasses,
  colorByClassification,
  colorByIntensity,
  colorByScalar,
} from '../colorModes';
import { computeScalarRange } from '../elevationRange';
import { classificationLabel } from '../pointInfo';
import type { ProfileAttribute, ProfileSectionPoints } from './profileSectionBuilder';
import { profileSectionHas } from './profileSectionBuilder';

// ─────────────────────────────────────────────────────────────────────────────
// Modes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four scalars a section can ramp.
 *
 * Every one of them is ORDERED: height rises, intensity is a return strength,
 * a 2nd return follows a 1st, and GPS time runs forwards. A perceptual ramp
 * encodes that order honestly. Nothing else belongs in this union — adding a
 * member is the act of claiming its values have a magnitude.
 */
export type ProfileRampMode = 'height' | 'intensity' | 'returnNumber' | 'gpsTime';

/**
 * The three id-like attributes, painted from a qualitative palette.
 *
 * Class 6 is not twice class 3 and flight line 7 is not more than flight line
 * 3, so these get colours that differ without ordering. They are excluded from
 * {@link ProfileRampMode} by construction, which is how `colorModes.ts` keeps
 * `pointSourceId` off its ramps: the type simply does not admit them.
 */
export type ProfileCategoricalMode = 'classification' | 'sourceLayer' | 'pointSourceId';

/** RGB, which is already a colour and is copied through unchanged. */
export type ProfileDirectMode = 'rgb';

/** Everything a section can be coloured by. */
export type ProfileColourMode = ProfileRampMode | ProfileCategoricalMode | ProfileDirectMode;

/** How a mode turns a value into a colour. */
export type ProfileColourKind = 'ramp' | 'categorical' | 'direct' | 'unavailable';

const RAMP_MODES: ReadonlySet<ProfileColourMode> = new Set<ProfileRampMode>([
  'height',
  'intensity',
  'returnNumber',
  'gpsTime',
]);

const CATEGORICAL_MODES: ReadonlySet<ProfileColourMode> = new Set<ProfileCategoricalMode>([
  'classification',
  'sourceLayer',
  'pointSourceId',
]);

/** Every mode, in the order a picker should list them. */
export const PROFILE_COLOUR_MODES: readonly ProfileColourMode[] = [
  'rgb',
  'height',
  'intensity',
  'classification',
  'returnNumber',
  'gpsTime',
  'sourceLayer',
  'pointSourceId',
];

/** Whether `mode` ramps, keys a qualitative palette, or copies bytes. */
export function profileColourKind(mode: ProfileColourMode): Exclude<ProfileColourKind, 'unavailable'> {
  if (RAMP_MODES.has(mode)) return 'ramp';
  if (CATEGORICAL_MODES.has(mode)) return 'categorical';
  return 'direct';
}

/**
 * The ramp each ordered scalar uses.
 *
 * Height keeps elevation's Turbo default and the other three keep the scalar
 * default (CVD-safe Cividis), the same split `colorModes.ts` makes, so a
 * section and the 3D scene show one scalar in one ramp.
 *
 * This is the only function in the module that names a palette, and its
 * parameter type is {@link ProfileRampMode}. A categorical mode cannot be
 * passed to it, so no ramp lookup can be reached for an unordered id.
 */
export function profileRampPalette(mode: ProfileRampMode): ElevationPalette {
  return mode === 'height' ? DEFAULT_ELEVATION_PALETTE : DEFAULT_SCALAR_PALETTE;
}

/** The presence bit a mode reads, or null when the mode needs no channel. */
function attributeFor(mode: ProfileColourMode): ProfileAttribute | null {
  switch (mode) {
    case 'rgb':
      return 'rgb';
    case 'intensity':
      return 'intensity';
    case 'classification':
      return 'classification';
    case 'returnNumber':
      return 'returnNumber';
    case 'gpsTime':
      return 'gpsTime';
    case 'pointSourceId':
      return 'pointSourceId';
    // Height and source slot are recorded for every accepted return by the
    // section builder itself, so they have no presence bit to read.
    case 'height':
    case 'sourceLayer':
      return null;
  }
}

/** True when the section carries the array `mode` reads at all. */
function channelPresent(points: ProfileSectionPoints, mode: ProfileColourMode): boolean {
  switch (mode) {
    case 'rgb':
      return points.rgb != null;
    case 'intensity':
      return points.intensity != null;
    case 'classification':
      return points.classification != null;
    case 'returnNumber':
      return points.returnNumber != null;
    case 'gpsTime':
      return points.gpsTime != null;
    case 'pointSourceId':
      return points.pointSourceId != null;
    case 'height':
    case 'sourceLayer':
      return true;
  }
}

/** The value `mode` reads at section index `i`. Ramp and categorical only. */
function valueAt(points: ProfileSectionPoints, mode: ProfileColourMode, i: number): number {
  switch (mode) {
    case 'height':
      return points.height[i];
    case 'intensity':
      return points.intensity![i];
    case 'returnNumber':
      return points.returnNumber![i];
    case 'gpsTime':
      return points.gpsTime![i];
    case 'classification':
      return points.classification![i];
    case 'pointSourceId':
      return points.pointSourceId![i];
    case 'sourceLayer':
      return points.sourceSlot[i];
    case 'rgb':
      return 0;
  }
}

/**
 * True when point `i` carries what `mode` needs.
 *
 * Structural attributes are always carried. A channel attribute is carried
 * only where its presence bit is set, and a ramped value additionally has to
 * be finite: a NaN height is as absent as a missing one, and both belong in
 * the unknown bucket rather than at a ramp endpoint.
 */
function supports(points: ProfileSectionPoints, mode: ProfileColourMode, i: number): boolean {
  if (i < 0 || i >= points.count) return false;
  const attr = attributeFor(mode);
  if (attr !== null && !profileSectionHas(points, i, attr)) return false;
  if (RAMP_MODES.has(mode)) return Number.isFinite(valueAt(points, mode, i));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fewest supporting points a mode needs before it is offered.
 *
 * Below this the colouring is a handful of stray dots against a field of
 * unknown grey, which reads as a rendering fault rather than as a thin
 * attribute.
 */
export const PROFILE_MODE_MIN_POINTS = 8;

/** Smallest share of the displayed points a mode needs behind it. */
export const PROFILE_MODE_MIN_FRACTION = 0.25;

/** Why a mode is or is not offered. */
export type ProfileModeReason =
  /** Offered. */
  | 'ok'
  /** No source in the section carries the attribute. */
  | 'absent'
  /** Fewer than {@link PROFILE_MODE_MIN_POINTS} displayed points carry it. */
  | 'tooFewPoints'
  /** Under {@link PROFILE_MODE_MIN_FRACTION} of the displayed points carry it. */
  | 'tooSmallFraction'
  /** Every supporting point carries the same value, so the mode has one colour. */
  | 'noVariation';

/** What the availability rule found for one mode. */
export interface ProfileModeAvailability {
  readonly mode: ProfileColourMode;
  readonly available: boolean;
  readonly reason: ProfileModeReason;
  /** Displayed points that carry the attribute. */
  readonly supporting: number;
  /** Displayed points in total. */
  readonly displayed: number;
  /**
   * Distinct values among the supporting points, counted up to 2. Two is all
   * the rule needs, and stopping there keeps a 16-bit id space from building a
   * set the size of the section.
   */
  readonly distinct: number;
}

/**
 * Whether `mode` has enough behind it to be offered for `indices`.
 *
 * THE RULE. A mode is available when all three hold:
 *
 *   1. the section carries the attribute at all (some source supplied it);
 *   2. at least {@link PROFILE_MODE_MIN_POINTS} of the displayed points carry
 *      it, AND at least {@link PROFILE_MODE_MIN_FRACTION} of them do;
 *   3. those supporting points hold at least two distinct values.
 *
 * The count and the fraction are both required because either alone fails at
 * one end: a fixed count would offer a mode backed by 30 points out of a
 * million, and a fraction alone would offer one backed by 3 points out of 6.
 *
 * Clause 3 is what "one colour" means per kind. A ramp whose supporting values
 * do not vary paints every point the ramp's bottom colour; a categorical mode
 * with one category paints every point one swatch. In both cases the picture
 * carries no information the section did not already show, and a uniform wash
 * reads as a broken render — the same reasoning `colorModeSupport.ts` gives for
 * refusing a mode whose attribute is missing outright.
 */
export function profileModeAvailability(
  points: ProfileSectionPoints,
  mode: ProfileColourMode,
  indices: ArrayLike<number>,
): ProfileModeAvailability {
  const displayed = indices.length;
  if (!channelPresent(points, mode)) {
    return { mode, available: false, reason: 'absent', supporting: 0, displayed, distinct: 0 };
  }

  let supporting = 0;
  let distinct = 0;
  const direct = mode === 'rgb';
  const rgb = points.rgb;
  let firstKey = 0;
  let sawFirst = false;

  for (let k = 0; k < displayed; k++) {
    const i = indices[k];
    if (!supports(points, mode, i)) continue;
    supporting++;
    if (distinct >= 2) continue;
    const key = direct
      ? (rgb![i * 3] << 16) | (rgb![i * 3 + 1] << 8) | rgb![i * 3 + 2]
      : valueAt(points, mode, i);
    if (!sawFirst) {
      firstKey = key;
      sawFirst = true;
      distinct = 1;
    } else if (key !== firstKey) {
      distinct = 2;
    }
  }

  const fraction = displayed === 0 ? 0 : supporting / displayed;
  let reason: ProfileModeReason = 'ok';
  if (supporting < PROFILE_MODE_MIN_POINTS) reason = 'tooFewPoints';
  else if (fraction < PROFILE_MODE_MIN_FRACTION) reason = 'tooSmallFraction';
  else if (distinct < 2) reason = 'noVariation';

  return { mode, available: reason === 'ok', reason, supporting, displayed, distinct };
}

/** Every mode the section can honestly offer for `indices`, in picker order. */
export function availableProfileColourModes(
  points: ProfileSectionPoints,
  indices: ArrayLike<number>,
): ProfileColourMode[] {
  return PROFILE_COLOUR_MODES.filter((m) => profileModeAvailability(points, m, indices).available);
}

// ─────────────────────────────────────────────────────────────────────────────
// Height range
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which heights the ramp is normalised against.
 *
 * `sectionLocal` spends the whole palette on this cut, which shows its shape
 * best and makes two cuts incomparable. `activeLayer` normalises one layer
 * against itself, so a thin layer inside a tall section keeps its detail.
 * `projectShared` uses a window the caller holds for the whole project, which
 * is the only one under which two sections can be read side by side.
 */
export type ProfileHeightRangeScope = 'sectionLocal' | 'activeLayer' | 'projectShared';

/** A height-range request. The caller picks; this module never guesses. */
export type ProfileHeightRangeRequest =
  | { readonly scope: 'sectionLocal' }
  | { readonly scope: 'activeLayer'; readonly slot: number }
  | { readonly scope: 'projectShared'; readonly min: number; readonly max: number };

/**
 * The window a ramp was normalised against, and where it came from.
 *
 * Returned with the colours so a legend can state the scope rather than
 * implying one. `trueMin` / `trueMax` are the unclipped extremes of whatever
 * was sampled, so a legend can say the endpoints are a percentile window.
 */
export interface ProfileRampRange {
  readonly scope: ProfileHeightRangeScope;
  readonly min: number;
  readonly max: number;
  readonly trueMin: number;
  readonly trueMax: number;
  /** Set only for `activeLayer`. */
  readonly slot?: number;
  /** Human label for the scope, e.g. "This section". */
  readonly label: string;
}

const SCOPE_LABEL: Readonly<Record<ProfileHeightRangeScope, string>> = {
  sectionLocal: 'This section',
  activeLayer: 'Active layer',
  projectShared: 'Project shared',
};

/**
 * The scope a mode other than height ranges over.
 *
 * Intensity, return number, and GPS time are normalised against the section's
 * own supporting values. They are reported with the same `scope` field as
 * height so a legend reads one shape for every ramp, and so "section local"
 * is stated rather than assumed.
 */
const NON_HEIGHT_SCOPE: ProfileHeightRangeScope = 'sectionLocal';

/**
 * Default height scope, applied when a caller passes none.
 *
 * Section-local, and named as such in the returned legend. The default exists
 * so a caller can omit the field; it does not let the choice go unreported.
 */
export const DEFAULT_PROFILE_HEIGHT_SCOPE: ProfileHeightRangeRequest = { scope: 'sectionLocal' };

// ─────────────────────────────────────────────────────────────────────────────
// Qualitative palette
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Qualitative colours for unordered ids — flight lines and source layers.
 *
 * Hues chosen to be far apart with no luminance order, so nothing about the
 * sequence suggests a magnitude. Cycled by position in the sorted id list, so
 * a section with more ids than colours repeats rather than ramps.
 */
const QUALITATIVE: readonly (readonly [number, number, number])[] = [
  [ 31, 119, 180],
  [255, 127,  14],
  [ 44, 160,  44],
  [214,  39,  40],
  [148, 103, 189],
  [140,  86,  75],
  [227, 119, 194],
  [127, 127, 127],
  [188, 189,  34],
  [ 23, 190, 207],
  [ 96,  70, 160],
  [200, 160,  60],
];

/**
 * The colourblind-safe qualitative set — Okabe-Ito, the same palette the
 * colourblind-safe class colours in `colorModes.ts` are built on.
 *
 * Selected by the SAME global switch, read through `colorblindSafeClasses()`.
 * A user who turned that on to separate ground from buildings would otherwise
 * still get red/green flight lines from the set above.
 */
const QUALITATIVE_CVD: readonly (readonly [number, number, number])[] = [
  [  0, 114, 178],
  [230, 159,   0],
  [  0, 158, 115],
  [213,  94,   0],
  [204, 121, 167],
  [ 86, 180, 233],
  [240, 228,  66],
  [ 90,  90,  90],
];

/** The qualitative palette the colourblind-safe setting currently selects. */
function qualitativePalette(): readonly (readonly [number, number, number])[] {
  return colorblindSafeClasses() ? QUALITATIVE_CVD : QUALITATIVE;
}

/**
 * The colour a point takes when its attribute is absent.
 *
 * A desaturated slate that no ramp endpoint and no class swatch lands on, and
 * that no greyscale value can equal (its blue channel differs from its red and
 * green). Absent has to look like absent, not like a low measurement.
 */
export const PROFILE_UNKNOWN_COLOUR: readonly [number, number, number] = [110, 110, 118];

// ─────────────────────────────────────────────────────────────────────────────
// Legend
// ─────────────────────────────────────────────────────────────────────────────

/** One swatch of a categorical legend. */
export interface ProfileColourCategory {
  /** The class code, source id, or source slot this swatch stands for. */
  readonly value: number;
  readonly label: string;
  readonly colour: readonly [number, number, number];
  /** Displayed points that took this swatch. */
  readonly count: number;
}

/** The legend row for points whose attribute was absent. */
export interface ProfileUnknownBucket {
  readonly label: string;
  readonly colour: readonly [number, number, number];
  readonly count: number;
}

/**
 * Everything a legend needs to describe the colouring it labels.
 *
 * `range` and `categories` are mutually exclusive by `kind`, and `unknown` is
 * non-null exactly when at least one displayed point was coloured as unknown,
 * so a legend can never omit a bucket the picture contains.
 */
export interface ProfileColourLegend {
  readonly mode: ProfileColourMode;
  readonly kind: ProfileColourKind;
  /** Set for `ramp`; null otherwise, including for every categorical mode. */
  readonly palette: ElevationPalette | null;
  /** Set for `ramp`; carries the scope the window came from. */
  readonly range: ProfileRampRange | null;
  /** Set for `categorical`, ordered by ascending value. */
  readonly categories: readonly ProfileColourCategory[] | null;
  /** Non-null when the picture contains unknown-coloured points. */
  readonly unknown: ProfileUnknownBucket | null;
  /** Whether the colourblind-safe categorical palettes were in force. */
  readonly colourblindSafe: boolean;
}

/** What one colouring pass produced. */
export interface ProfileColourResult {
  readonly mode: ProfileColourMode;
  /** Triplets written into the output buffer. Equals `indices.length`. */
  readonly count: number;
  /** How many of those took {@link PROFILE_UNKNOWN_COLOUR}. */
  readonly unknownCount: number;
  readonly availability: ProfileModeAvailability;
  readonly legend: ProfileColourLegend;
}

/** A colouring request. */
export interface ProfileColourRequest {
  readonly points: ProfileSectionPoints;
  readonly mode: ProfileColourMode;
  /** Section indices to colour, in the order the caller draws them. */
  readonly indices: ArrayLike<number>;
  /**
   * Which heights the height ramp normalises against. Defaults to
   * {@link DEFAULT_PROFILE_HEIGHT_SCOPE}, and whatever is used is reported in
   * `legend.range.scope`.
   */
  readonly heightRange?: ProfileHeightRangeRequest;
  /** Layer names by source slot, for the `sourceLayer` legend. */
  readonly sourceLabels?: ReadonlyMap<number, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Colouring
// ─────────────────────────────────────────────────────────────────────────────

function writeUnknown(out: Uint8Array, k: number): void {
  out[k * 3] = PROFILE_UNKNOWN_COLOUR[0];
  out[k * 3 + 1] = PROFILE_UNKNOWN_COLOUR[1];
  out[k * 3 + 2] = PROFILE_UNKNOWN_COLOUR[2];
}

function unknownBucket(count: number): ProfileUnknownBucket | null {
  return count === 0
    ? null
    : { label: 'Unknown (attribute not carried)', colour: PROFILE_UNKNOWN_COLOUR, count };
}

/**
 * Fill `out` with one RGB triplet per entry of `request.indices`.
 *
 * `out` must hold at least `indices.length * 3` bytes; a shorter buffer throws
 * rather than colouring part of the section.
 *
 * A mode the availability rule refuses is not encoded at all: every displayed
 * point takes the unknown colour and the legend comes back with kind
 * `'unavailable'`. Painting it anyway would show a picture the data does not
 * support, and a caller that offers only
 * {@link availableProfileColourModes} never reaches this branch.
 */
export function colourProfileSection(
  request: ProfileColourRequest,
  out: Uint8Array,
): ProfileColourResult {
  const { points, mode, indices } = request;
  const n = indices.length;
  if (out.length < n * 3) {
    throw new RangeError(`profile colour buffer holds ${out.length} bytes, needs ${n * 3}`);
  }

  const availability = profileModeAvailability(points, mode, indices);
  const colourblindSafe = colorblindSafeClasses();

  if (!availability.available) {
    for (let k = 0; k < n; k++) writeUnknown(out, k);
    return {
      mode,
      count: n,
      unknownCount: n,
      availability,
      legend: {
        mode,
        kind: 'unavailable',
        palette: null,
        range: null,
        categories: null,
        unknown: unknownBucket(n),
        colourblindSafe,
      },
    };
  }

  switch (profileColourKind(mode)) {
    case 'direct':
      return colourDirect(request, out, availability, colourblindSafe);
    case 'categorical':
      return colourCategorical(
        request,
        mode as ProfileCategoricalMode,
        out,
        availability,
        colourblindSafe,
      );
    case 'ramp':
      return colourRamp(request, mode as ProfileRampMode, out, availability, colourblindSafe);
  }
}

/** RGB — the bytes the source already carried, copied through. */
function colourDirect(
  request: ProfileColourRequest,
  out: Uint8Array,
  availability: ProfileModeAvailability,
  colourblindSafe: boolean,
): ProfileColourResult {
  const { points, indices } = request;
  const n = indices.length;
  const rgb = points.rgb!;
  let unknown = 0;
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    if (!supports(points, 'rgb', i)) {
      writeUnknown(out, k);
      unknown++;
      continue;
    }
    out[k * 3] = rgb[i * 3];
    out[k * 3 + 1] = rgb[i * 3 + 1];
    out[k * 3 + 2] = rgb[i * 3 + 2];
  }
  return {
    mode: 'rgb',
    count: n,
    unknownCount: unknown,
    availability,
    legend: {
      mode: 'rgb',
      kind: 'direct',
      palette: null,
      range: null,
      categories: null,
      unknown: unknownBucket(unknown),
      colourblindSafe,
    },
  };
}

/**
 * Classification, source layer, and point source id.
 *
 * The distinct values are sorted ascending and the palette is indexed by
 * position in that sorted list, so an id's colour depends only on the set of
 * ids in the section — never on the order the returns were drawn in, and never
 * on a hash or a random draw. Classification does not use that palette at all:
 * it goes through `colorByClassification` and `classColor`, so the section
 * shows the ASPRS colours the 3D scene shows, including the colourblind-safe
 * variant when that setting is on.
 */
function colourCategorical(
  request: ProfileColourRequest,
  mode: ProfileCategoricalMode,
  out: Uint8Array,
  availability: ProfileModeAvailability,
  colourblindSafe: boolean,
): ProfileColourResult {
  const { points, indices, sourceLabels } = request;
  const n = indices.length;

  // Gather the supporting values, and the output slot each belongs to.
  const values = new Float64Array(n);
  const slots = new Uint32Array(n);
  let m = 0;
  let unknown = 0;
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    if (!supports(points, mode, i)) {
      writeUnknown(out, k);
      unknown++;
      continue;
    }
    values[m] = valueAt(points, mode, i);
    slots[m] = k;
    m++;
  }

  const counts = new Map<number, number>();
  for (let j = 0; j < m; j++) counts.set(values[j], (counts.get(values[j]) ?? 0) + 1);
  const ordered = [...counts.keys()].sort((a, b) => a - b);

  const categories: ProfileColourCategory[] = [];
  const colourOf = new Map<number, readonly [number, number, number]>();

  if (mode === 'classification') {
    // One shared pass through OLV's class palette, so a section and the scene
    // paint the same code the same colour.
    const packed = new Uint8Array(m);
    for (let j = 0; j < m; j++) packed[j] = values[j] & 0xff;
    const bytes = colorByClassification(packed, m);
    for (let j = 0; j < m; j++) {
      const k = slots[j];
      out[k * 3] = bytes[j * 3];
      out[k * 3 + 1] = bytes[j * 3 + 1];
      out[k * 3 + 2] = bytes[j * 3 + 2];
    }
    for (const code of ordered) {
      categories.push({
        value: code,
        label: classificationLabel(code),
        colour: classColor(code),
        count: counts.get(code)!,
      });
    }
  } else {
    const palette = qualitativePalette();
    ordered.forEach((value, rank) => colourOf.set(value, palette[rank % palette.length]));
    for (let j = 0; j < m; j++) {
      const c = colourOf.get(values[j])!;
      const k = slots[j];
      out[k * 3] = c[0];
      out[k * 3 + 1] = c[1];
      out[k * 3 + 2] = c[2];
    }
    for (const value of ordered) {
      const label =
        mode === 'sourceLayer'
          ? (sourceLabels?.get(value) ?? `Layer ${value}`)
          : `Source ${value}`;
      const c = colourOf.get(value)!;
      categories.push({ value, label, colour: [c[0], c[1], c[2]], count: counts.get(value)! });
    }
  }

  return {
    mode,
    count: n,
    unknownCount: unknown,
    availability,
    legend: {
      mode,
      kind: 'categorical',
      // No palette: a categorical legend draws swatches, not a bar. Naming a
      // ramp here is the mistake this field's null-ness exists to prevent.
      palette: null,
      range: null,
      categories,
      unknown: unknownBucket(unknown),
      colourblindSafe,
    },
  };
}

/**
 * Height, intensity, return number, and GPS time.
 *
 * Values are gathered from the supporting points only, ranged, and then
 * handed to the same `colorByIntensity` / `colorByScalar` the scene uses, so
 * the section's pixels come out of OLV's one ramp implementation. Points
 * without the attribute never enter the gathered buffer, so they neither take
 * a colour nor move the window.
 */
function colourRamp(
  request: ProfileColourRequest,
  mode: ProfileRampMode,
  out: Uint8Array,
  availability: ProfileModeAvailability,
  colourblindSafe: boolean,
): ProfileColourResult {
  const { points, indices } = request;
  const n = indices.length;
  const values = new Float64Array(n);
  const slots = new Uint32Array(n);
  let m = 0;
  let unknown = 0;
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    if (!supports(points, mode, i)) {
      writeUnknown(out, k);
      unknown++;
      continue;
    }
    values[m] = valueAt(points, mode, i);
    slots[m] = k;
    m++;
  }

  const range = resolveRampRange(request, mode, values, m);
  const palette = profileRampPalette(mode);
  const bytes =
    mode === 'intensity'
      ? colorByIntensity(values, m, range.min, range.max, palette)
      : colorByScalar(values, m, range.min, range.max, palette);

  for (let j = 0; j < m; j++) {
    const k = slots[j];
    out[k * 3] = bytes[j * 3];
    out[k * 3 + 1] = bytes[j * 3 + 1];
    out[k * 3 + 2] = bytes[j * 3 + 2];
  }

  return {
    mode,
    count: n,
    unknownCount: unknown,
    availability,
    legend: {
      mode,
      kind: 'ramp',
      palette,
      range,
      categories: null,
      unknown: unknownBucket(unknown),
      colourblindSafe,
    },
  };
}

/**
 * The window a ramp normalises against, tagged with where it came from.
 *
 * Height honours the requested scope. `projectShared` takes the caller's
 * window verbatim — it is the caller's, and narrowing it would break the
 * comparison between sections it exists for. `activeLayer` re-gathers the
 * heights of one source slot; a slot with no displayed points falls back to
 * the section's own heights AND says so by reporting `sectionLocal`, because a
 * legend that named an empty layer would describe a window that was not used.
 *
 * Return number ranges on raw finite min/max: the ordinals are small, have no
 * outlier failure mode, and a percentile trim would fold the deepest returns
 * into the top stop. The other scalars keep the p5–p95 clip
 * `computeScalarRange` applies by default.
 */
function resolveRampRange(
  request: ProfileColourRequest,
  mode: ProfileRampMode,
  gathered: Float64Array,
  m: number,
): ProfileRampRange {
  const raw = mode === 'returnNumber' ? { lowerPercentile: 0, upperPercentile: 100 } : {};

  if (mode !== 'height') {
    const r = computeScalarRange(gathered, { count: m, ...raw });
    return {
      scope: NON_HEIGHT_SCOPE,
      min: r.min,
      max: r.max,
      trueMin: r.trueMin,
      trueMax: r.trueMax,
      label: SCOPE_LABEL[NON_HEIGHT_SCOPE],
    };
  }

  const req = request.heightRange ?? DEFAULT_PROFILE_HEIGHT_SCOPE;

  if (req.scope === 'projectShared') {
    return {
      scope: 'projectShared',
      min: req.min,
      max: req.max,
      trueMin: req.min,
      trueMax: req.max,
      label: SCOPE_LABEL.projectShared,
    };
  }

  if (req.scope === 'activeLayer') {
    const { points, indices } = request;
    const layer = new Float64Array(indices.length);
    let c = 0;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (!supports(points, 'height', i)) continue;
      if (points.sourceSlot[i] !== req.slot) continue;
      layer[c++] = points.height[i];
    }
    if (c > 0) {
      const r = computeScalarRange(layer, { count: c });
      return {
        scope: 'activeLayer',
        min: r.min,
        max: r.max,
        trueMin: r.trueMin,
        trueMax: r.trueMax,
        slot: req.slot,
        label: SCOPE_LABEL.activeLayer,
      };
    }
  }

  const r = computeScalarRange(gathered, { count: m });
  return {
    scope: 'sectionLocal',
    min: r.min,
    max: r.max,
    trueMin: r.trueMin,
    trueMax: r.trueMax,
    label: SCOPE_LABEL.sectionLocal,
  };
}
