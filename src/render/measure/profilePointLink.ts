/**
 * profilePointLink.ts
 *
 * The identity a profile return is followed by, and what that identity
 * resolves to in the live scene.
 *
 * A section is a SNAPSHOT. It records, per accepted return, the slot it came
 * from and that source's own point index; the seam records what each slot was
 * — a static layer id, or a streaming octree node key. Those two together are
 * the whole route back to the scene:
 *
 *   static     slot -> layer id -> point index -> placed project coordinate
 *   streaming  slot -> node key -> point index -> resident decoded point
 *
 * NOTHING HERE MATCHES ON COORDINATES. A corridor is a band a few metres wide
 * around one line, so its returns are close together by construction and a
 * nearest-XYZ lookup would answer with a neighbour for most of them — silently,
 * and more often the denser the scan. The identity is carried, not recovered.
 *
 * THE SNAPSHOT OUTLIVES THE SCENE. A streaming node resident when the corridor
 * was walked can be evicted a moment later, and a static layer can be removed
 * or hidden. The 2D section still holds every figure it recorded, so it stays
 * on screen; only the 3D link goes. {@link ProfileLinkState} keeps those two
 * apart — `evicted` names the streaming case specifically, because a node that
 * has left residency is expected and reversible, while a source that is gone
 * for another reason is not. Neither is ever reported as `linked`.
 *
 * Pure and DOM-free: no canvas, no three.js, no viewer. The live scene arrives
 * as a {@link ProfileReturnLocator} function, so the whole route runs under
 * Node against plain arrays.
 */

import { heightLabel, type VerticalReference } from '../../geo/height';
import { classificationLabel } from '../pointInfo';
import { formatStation } from './profileSummary';
import { profileSectionHas } from './profileSectionBuilder';

import type { ProfileReturnsSource } from './profileReturnsCsv';
import type { ProfileSectionPoints } from './profileSectionBuilder';
import type { ProfileSectionSourceRef } from './profileSectionSeam';
import type { UnitSystem } from './types';

/** What one section slot was read from. Mirrors `ProfileSectionSourceRef`. */
export type ProfileSourceKind = 'static' | 'resident';

/**
 * The stable route from one section return back to the scene.
 *
 * `sectionIndex` addresses the 2D arrays; the other three address the source.
 * They are recorded together so a consumer can never pair a 2D figure with a
 * different source point than the one it was read from.
 */
export interface ProfileReturnIdentity {
  /** Index into the section arrays. */
  readonly sectionIndex: number;
  /** The builder slot this return was pushed under. */
  readonly slot: number;
  readonly kind: ProfileSourceKind;
  /** Layer id for a static source; octree node key for a resident one. */
  readonly sourceId: string;
  /** The point's index in its OWN source, not in the section. */
  readonly pointIndex: number;
}

/**
 * Whether the source point behind a return can still be pointed at.
 *
 *   - `linked`      the source is present and yielded a coordinate;
 *   - `evicted`     the streaming node that carried it is no longer resident;
 *   - `unavailable` any other reason there is no coordinate to give — the
 *                   static layer is gone or is no longer eligible, the index
 *                   is outside the source, or the buffer was dropped.
 */
export type ProfileLinkState = 'linked' | 'evicted' | 'unavailable';

/** An identity resolved against the scene as it is right now. */
export interface ProfileReturnLink {
  readonly identity: ProfileReturnIdentity;
  readonly state: ProfileLinkState;
  /** The project-frame position, and ONLY when `state` is `linked`. */
  readonly position: readonly [number, number, number] | null;
}

/**
 * The live scene, as one function.
 *
 * Writes the project-frame coordinate into `out[0..2]` and returns `linked`,
 * or leaves `out` alone and returns why it could not.
 */
export type ProfileReturnLocator = (
  identity: ProfileReturnIdentity,
  out: Float64Array,
) => ProfileLinkState;

/**
 * The identity of section return `i`, or `null` when there is none.
 *
 * `null` covers an index outside the section and a slot no source ref names.
 * An unnamed slot is a section whose sources and points disagree, and guessing
 * a source for it would attach the return to a layer it never came from.
 */
export function profileReturnIdentity(
  points: ProfileSectionPoints,
  sources: readonly ProfileSectionSourceRef[],
  i: number,
): ProfileReturnIdentity | null {
  if (!Number.isInteger(i) || i < 0 || i >= points.count) return null;
  const slot = points.sourceSlot[i]!;
  const ref = sources.find((s) => s.slot === slot);
  if (!ref) return null;
  return {
    sectionIndex: i,
    slot,
    kind: ref.kind,
    sourceId: ref.id,
    pointIndex: points.pointIndex[i]!,
  };
}

/**
 * Resolve an identity against the live scene.
 *
 * A locator that answers `linked` with a non-finite coordinate is downgraded
 * to `unavailable`: a marker at NaN is not a marker, and reporting the link as
 * live would claim a position nothing can be drawn at.
 */
export function locateProfileReturn(
  identity: ProfileReturnIdentity,
  locate: ProfileReturnLocator,
  scratch?: Float64Array,
): ProfileReturnLink {
  const out = scratch ?? new Float64Array(3);
  const state = locate(identity, out);
  if (state !== 'linked') return { identity, state, position: null };
  const x = out[0]!;
  const y = out[1]!;
  const z = out[2]!;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return { identity, state: 'unavailable', position: null };
  }
  return { identity, state: 'linked', position: [x, y, z] };
}

/** The sentence a panel shows for a link state. */
export function profileLinkNote(state: ProfileLinkState): string {
  switch (state) {
    case 'linked':
      return 'Marked in the 3D view.';
    case 'evicted':
      return 'The streaming node behind this return is no longer loaded, so it cannot be marked in 3D.';
    case 'unavailable':
      return 'This return has no live source in the scene, so it cannot be marked in 3D.';
  }
}

/** The short value the detail list carries for a link state. */
export function profileLinkStatusText(state: ProfileLinkState): string {
  switch (state) {
    case 'linked':
      return 'marked in 3D';
    case 'evicted':
      return 'source node evicted';
    case 'unavailable':
      return 'source unavailable';
  }
}

/**
 * Source records for the detail card, from the section's own source refs.
 *
 * The seam records a static layer under the id the layer is named by, so the
 * id IS the display name here; inventing a second name would let the card
 * disagree with the returns export about which layer a return came from. A
 * resident slot additionally carries its octree key, which is the one row that
 * distinguishes a streaming return from a static one.
 *
 * `readXYZ` is the SAME locator the 3D marker uses, so the card's world
 * coordinates are read from the scene as it is now: an evicted node's rows go
 * unknown rather than showing the position it used to be at.
 */
export function profileDetailSources(
  sources: readonly ProfileSectionSourceRef[],
  locate?: ProfileReturnLocator,
): ProfileReturnsSource[] {
  return sources.map((s) => {
    const readXYZ = locate
      ? (index: number, out: Float64Array): boolean =>
          locate(
            { sectionIndex: -1, slot: s.slot, kind: s.kind, sourceId: s.id, pointIndex: index },
            out,
          ) === 'linked'
      : undefined;
    return s.kind === 'resident'
      ? {
          slot: s.slot,
          layerId: s.id,
          layerName: s.id,
          streamingNodeKey: s.id,
          ...(readXYZ ? { readXYZ } : {}),
        }
      : { slot: s.slot, layerId: s.id, layerName: s.id, ...(readXYZ ? { readXYZ } : {}) };
  });
}

/**
 * Arm length of the 3D marker, in the section's own units.
 *
 * Derived from the corridor half width rather than fixed, because a corridor
 * is the only length the section knows to be meaningful at this scale: a
 * 0.5 m band and a 50 m band want markers three orders of magnitude apart, and
 * a constant would be invisible in one and a wall across the other. A
 * non-positive or non-finite band falls back to a unit arm, which is at least
 * drawable.
 */
export const MARKER_BAND_FRACTION = 0.35;

export function profileMarkerSize(band: number): number {
  if (!Number.isFinite(band) || band <= 0) return 1;
  return band * MARKER_BAND_FRACTION;
}

/**
 * Endpoints of a three-axis cross centred on `position`, as interleaved XYZ.
 *
 * Six vertices, three segments. Axis aligned rather than screen aligned so it
 * needs no camera and no per-frame update: it is a scene object like any
 * other, and it stays put while the user orbits.
 */
export function profileMarkerSegments(
  position: readonly [number, number, number],
  size: number,
  out?: Float32Array,
): Float32Array {
  const v = out && out.length >= 18 ? out : new Float32Array(18);
  const s = Number.isFinite(size) && size > 0 ? size : 1;
  const [x, y, z] = position;
  v[0] = x - s; v[1] = y; v[2] = z;
  v[3] = x + s; v[4] = y; v[5] = z;
  v[6] = x; v[7] = y - s; v[8] = z;
  v[9] = x; v[10] = y + s; v[11] = z;
  v[12] = x; v[13] = y; v[14] = z - s;
  v[15] = x; v[16] = y; v[17] = z + s;
  return v;
}

/** A camera pose, structurally — `Viewer.getCameraPose()` satisfies it. */
export interface ProfileCameraPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

/**
 * The pose that puts `point` under the orbit pivot without changing the view.
 *
 * The eye moves by the same vector the pivot does, so the direction the camera
 * looks along and its distance from the pivot both survive. That is what makes
 * this a focus rather than a jump: the user keeps the orientation they had.
 *
 * ONLY EVER CALLED FROM A DELIBERATE ACTION. A hover that moved the camera
 * would make the plot unusable, because reading along the section would drag
 * the scene under the reader.
 */
export function focusPoseOnPoint(
  pose: ProfileCameraPose,
  point: readonly [number, number, number],
): { position: [number, number, number]; target: [number, number, number] } {
  const dx = point[0] - pose.target[0];
  const dy = point[1] - pose.target[1];
  const dz = point[2] - pose.target[2];
  return {
    position: [pose.position[0] + dx, pose.position[1] + dy, pose.position[2] + dz],
    target: [point[0], point[1], point[2]],
  };
}

/** Decimals the readout carries, matching the detail card's spatial rows. */
const READOUT_DECIMALS = 3;

export interface ProfileHoverReadoutOptions {
  /** Decides the height WORDING. Absent reads as an undeclared datum. */
  readonly reference?: VerticalReference;
  /** Station notation. Metric km+m, imperial 100-ft. Default metric. */
  readonly system?: UnitSystem;
  /**
   * Metres per section unit. With no known scale there is no station to
   * quote, so the readout leads with chainage instead of labelling render
   * units as a civil station — the same refusal the detail card makes.
   */
  readonly unitToMetres?: number;
}

/**
 * One line about the return under the pointer.
 *
 * Deliberately SHORT and deliberately a subset: where the return sits along
 * the section, how high it is, and its class where it carries one. Everything
 * else belongs to the card a click opens. A hover readout that grew into the
 * card would have to be laid out per pointer move, which is the cost this
 * whole path is arranged to avoid.
 *
 * The height wording comes from `heightLabel`, unchanged, so a hover and the
 * card can never name the same quantity differently.
 */
export function profileHoverReadout(
  points: ProfileSectionPoints,
  i: number,
  options: ProfileHoverReadoutOptions = {},
): string {
  if (!Number.isInteger(i) || i < 0 || i >= points.count) return '';
  const chainage = points.chainage[i]!;
  const height = points.height[i]!;
  const metres =
    typeof options.unitToMetres === 'number' &&
    Number.isFinite(options.unitToMetres) &&
    options.unitToMetres > 0
      ? options.unitToMetres
      : null;

  const parts: string[] = [];
  if (metres !== null && Number.isFinite(chainage)) {
    parts.push(`Station ${formatStation(chainage * metres, options.system ?? 'metric')}`);
  } else if (Number.isFinite(chainage)) {
    parts.push(`Chainage ${chainage.toFixed(READOUT_DECIMALS)}`);
  }
  if (Number.isFinite(height)) {
    parts.push(`${heightLabel(options.reference ?? 'unknown')} ${height.toFixed(READOUT_DECIMALS)}`);
  }
  // Absence is not zero: the class is quoted only where this return's own
  // presence bit is set, never read out of the zero-filled array.
  if (points.classification !== undefined && profileSectionHas(points, i, 'classification')) {
    const code = points.classification[i]!;
    parts.push(`${code} (${classificationLabel(code)})`);
  }
  return parts.join(' · ');
}
