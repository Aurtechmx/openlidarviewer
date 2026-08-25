/**
 * sanitizeCloud.ts
 *
 * The one place a file-loaded cloud is checked for coordinates that cannot be
 * placed in space. A malformed binary body (PLY / PCD / E57), a header whose
 * scale factor overflows the double range, or a text token like `nan` can all
 * put a NaN or ±Infinity into an x/y/z. `PointCloud.bounds()` already ignores
 * such a coordinate, so the CAMERA survives one — but the point itself stays in
 * the cloud and reaches rendering, measurement, volume and export, where a NaN
 * silently poisons whatever it touches.
 *
 * Excluding the point is only half the job. Colour, classification, intensity,
 * returns, source id and GPS time live in arrays PARALLEL to the positions:
 * index i of each describes point i. Shortening the positions while leaving an
 * attribute at full length shifts every value after the hole by one, so every
 * later point wears the wrong colour and the wrong class — a quiet, plausible-
 * looking corruption that is worse than the NaN it replaced. So the filter is
 * written once, here, and drives positions and every present attribute from a
 * SINGLE index. An attribute the file never carried stays absent.
 *
 * Order matters: the exclusion happens BEFORE the origin is chosen. The origin
 * is `floor(min)` over the cloud, and while a NaN cannot move a minimum (every
 * comparison against it is false), a -Infinity coordinate makes the minimum
 * -Infinity — and subtracting that origin would turn every surviving point into
 * NaN. Filtering first means the origin is derived only from points that are
 * actually going to be drawn, which is also the only origin that honestly
 * describes the cloud the viewer ends up holding.
 *
 * Scope: the FILE-LOADING path only. Streaming (COPC / EPT) node buffers are
 * accounted per node and must not silently lose points here; `voxelDownsample`
 * carries its own centroid guard.
 *
 * Pure — no DOM, no three.js — so it runs inside the parse worker.
 */

import type { CloudMetadata } from '../model/PointCloud';
import { computeOrigin, recenter } from './coordinateBridge';
import { LoadError } from './loadErrors';

/** Any per-point array the viewer stores alongside positions. */
type NumericArray = Uint8Array | Uint16Array | Float32Array | Float64Array;

/** Interleaved xyz coordinates, in either precision a loader stages them in. */
type Coordinates = Float32Array | Float64Array;

/**
 * The per-point arrays that must be filtered in lockstep with the positions —
 * the parallel attributes of {@link PointCloud}, each optional exactly as the
 * cloud has them.
 */
export interface CloudAttributes {
  colors?: Uint8Array;
  normals?: Float32Array;
  intensity?: Uint16Array;
  classification?: Uint8Array;
  returnNumber?: Uint8Array;
  returnCount?: Uint8Array;
  pointSourceId?: Uint16Array;
  gpsTime?: Float64Array;
}

/** Components per point for each attribute — the model's own layout. */
const ATTRIBUTE_WIDTH: Record<keyof CloudAttributes, number> = {
  colors: 3,
  normals: 3,
  intensity: 1,
  classification: 1,
  returnNumber: 1,
  returnCount: 1,
  pointSourceId: 1,
  gpsTime: 1,
};

const ATTRIBUTE_KEYS = Object.keys(ATTRIBUTE_WIDTH) as (keyof CloudAttributes)[];

/**
 * What the compaction did to record identity, for a caller that has to keep an
 * index into the PRE-sanitation records meaningful afterwards.
 *
 * The direction is deliberate. A forward table (output index to input index)
 * describes the same compaction, but every caller that holds a source index —
 * an organized-range grid, a per-record sidecar — would have to search it to
 * find where its record went. The question actually being asked is "where did
 * source record i land, if it landed at all", so the table is stored that way
 * and answered in one read.
 *
 * `identity` is not an optimisation detail leaking out: it is the common case,
 * and representing it as a shape rather than as a filled table is what lets a
 * clean cloud request the witness and still allocate nothing.
 */
export type CompactionWitness =
  | { readonly kind: 'identity'; readonly sourceCount: number }
  | {
      readonly kind: 'compacted';
      readonly sourceCount: number;
      /** Length `sourceCount`. Output index, or {@link RECORD_DROPPED}. */
      readonly sourceToOutput: Int32Array;
    };

/** The source record did not survive sanitation and has no output index. */
export const RECORD_DROPPED = -1;

/**
 * The witness says nothing about this index, because it never covered it.
 *
 * Distinct from {@link RECORD_DROPPED} deliberately. "This record was removed"
 * and "I was never asked about this record" are different facts, and a caller
 * that conflates them reads a bookkeeping mismatch as a decoding outcome. The
 * PTX loader treats this one as a reason to abandon the remap entirely rather
 * than to mark a cell, which is only the right response because it is
 * distinguishable.
 */
export const RECORD_NOT_WITNESSED = -2;

/**
 * Where source record `sourceIndex` ended up.
 *
 * Returns {@link RECORD_DROPPED} when the record was removed by sanitation and
 * {@link RECORD_NOT_WITNESSED} when the index lies outside what this witness
 * covers. Neither throws: an out-of-range index means the caller's bookkeeping
 * disagrees with the witness, which the caller has to handle rather than
 * having an exception decide for it.
 */
export function outputRecordFor(witness: CompactionWitness, sourceIndex: number): number {
  if (sourceIndex < 0 || sourceIndex >= witness.sourceCount) return RECORD_NOT_WITNESSED;
  if (witness.kind === 'identity') return sourceIndex;
  return witness.sourceToOutput[sourceIndex];
}

/** Opt-in extras a caller can ask sanitation for. */
export interface SanitizeOptions {
  /** Record how source indices map onto output indices. Off by default. */
  readonly witness?: boolean;
}

/** A cloud recentred and cleared of unplaceable points. */
export interface SanitizedCloud<A extends CloudAttributes> {
  /** Interleaved xyz in local coordinates, survivors only. */
  positions: Float32Array;
  /** The floored-min origin of the SURVIVING points. */
  origin: [number, number, number];
  /** The same attributes, filtered by the same index set. */
  attributes: A;
  /** How many points were excluded. */
  excludedCount: number;
  /** What was excluded and why, for `metadata.loadWarnings`; absent when nothing was. */
  warning?: string;
  /** Present exactly when the caller asked for it. */
  witness?: CompactionWitness;
}

/** A cloud cleared of unplaceable points, for positions that are already local. */
export interface SanitizedLocalCloud<A extends CloudAttributes> {
  positions: Float32Array;
  attributes: A;
  excludedCount: number;
  warning?: string;
  /** Present exactly when the caller asked for it. */
  witness?: CompactionWitness;
}

/** Allocate an array of the same kind as `src`, for the compacted copy. */
function like<T extends NumericArray>(src: T, length: number): T {
  const Ctor = src.constructor as new (n: number) => T;
  return new Ctor(length);
}

/** One attribute being carried from the source indices to the kept indices. */
interface AttributeSlot {
  key: keyof CloudAttributes;
  width: number;
  src: NumericArray;
  out: NumericArray;
}

/** State the honest warning / refusal wording needs. */
function exclusionWarning(excluded: number, total: number): string {
  return (
    `Excluded ${excluded} of ${total} points: their x/y/z carried a non-finite ` +
    `value (NaN or ±Infinity), so they could not be placed in space. Each ` +
    `excluded point's attributes were removed with it.`
  );
}

/**
 * Drop every point whose xyz is not fully finite, carrying the present
 * attributes along by the same index. Returns the inputs untouched when the
 * cloud is already clean, so a well-formed file allocates and copies nothing.
 */
function compactValidRecords<C extends Coordinates, A extends CloudAttributes>(
  coords: C,
  attributes: A,
  wantWitness: boolean,
): { coords: C; attributes: A; excludedCount: number; witness?: CompactionWitness } {
  // A trailing partial record means the decoder and the buffer disagree about
  // the point count; there is no honest way to guess the missing components.
  // `PointCloud` refuses the same shape at construction — refuse it earlier,
  // where the failure can still be described as a file problem.
  if (coords.length % 3 !== 0) {
    throw new LoadError(
      'malformed-file',
      `This file's coordinates are not whole xyz records (${coords.length} values).`,
    );
  }
  const count = coords.length / 3;

  const slots: AttributeSlot[] = [];
  for (const key of ATTRIBUTE_KEYS) {
    const src = attributes[key] as NumericArray | undefined;
    if (!src) continue;
    const width = ATTRIBUTE_WIDTH[key];
    if (src.length !== count * width) {
      throw new LoadError(
        'malformed-file',
        `This file's ${key} attribute has ${src.length} values for ${count} points.`,
      );
    }
    slots.push({ key, width, src, out: src });
  }

  let kept = 0;
  for (let i = 0; i < count; i++) {
    if (
      Number.isFinite(coords[i * 3]) &&
      Number.isFinite(coords[i * 3 + 1]) &&
      Number.isFinite(coords[i * 3 + 2])
    ) {
      kept++;
    }
  }
  if (kept === count) {
    // Nothing moved, so the witness is the identity map — and saying that costs
    // no table, which is what keeps an ordinary cloud on the free path.
    return {
      coords,
      attributes,
      excludedCount: 0,
      witness: wantWitness ? { kind: 'identity', sourceCount: count } : undefined,
    };
  }

  if (kept === 0) {
    throw new LoadError(
      'malformed-file',
      `None of this file's ${count} points can be placed in space — every one ` +
        `carries a non-finite x/y/z (NaN or ±Infinity).`,
    );
  }

  const keptCoords = like(coords, kept * 3);
  for (const slot of slots) slot.out = like(slot.src, kept * slot.width);
  // Seeded as dropped so the write loop only has to record survivors: a source
  // index the loop never reaches is, by construction, one that did not survive.
  const sourceToOutput = wantWitness ? new Int32Array(count).fill(RECORD_DROPPED) : undefined;

  // One loop, one index: positions and every attribute advance together, which
  // is what makes the lockstep guarantee structural rather than a convention
  // each caller has to remember.
  let w = 0;
  for (let i = 0; i < count; i++) {
    const x = coords[i * 3];
    const y = coords[i * 3 + 1];
    const z = coords[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (sourceToOutput) sourceToOutput[i] = w;
    keptCoords[w * 3] = x;
    keptCoords[w * 3 + 1] = y;
    keptCoords[w * 3 + 2] = z;
    for (const slot of slots) {
      for (let c = 0; c < slot.width; c++) {
        slot.out[w * slot.width + c] = slot.src[i * slot.width + c];
      }
    }
    w++;
  }

  // Spreading first keeps the caller's exact shape: a key the cloud never had
  // is not introduced here, it simply stays away.
  const filtered = { ...attributes };
  const writable = filtered as unknown as Record<string, NumericArray>;
  for (const slot of slots) writable[slot.key] = slot.out;
  return {
    coords: keptCoords,
    attributes: filtered,
    excludedCount: count - kept,
    witness: sourceToOutput ? { kind: 'compacted', sourceCount: count, sourceToOutput } : undefined,
  };
}

/**
 * Exclude unplaceable points from a cloud staged in global (float64)
 * coordinates, then recentre the survivors about their own floored-min origin.
 *
 * The entry point for every loader that stages coordinates before recentring.
 * An empty input is passed straight through: nothing was excluded, and the
 * parse choke point already refuses a zero-point file with its own message.
 */
export function sanitizeAndRecenter<A extends CloudAttributes>(
  global: Float64Array,
  attributes: A,
  options: SanitizeOptions = {},
): SanitizedCloud<A> {
  const valid = compactValidRecords(global, attributes, options.witness === true);
  if (valid.coords.length === 0) {
    return {
      positions: new Float32Array(0),
      origin: [0, 0, 0],
      attributes: valid.attributes,
      excludedCount: 0,
      // An empty witness rather than `undefined`, when one was requested: a caller must be able to tell an
      // empty cloud apart from a witness it did not ask for.
      witness: valid.witness,
    };
  }

  // Every remaining coordinate is finite, so the minimum is too — and the
  // origin it produces describes only the points the viewer will hold.
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  for (let i = 0; i < valid.coords.length; i += 3) {
    if (valid.coords[i] < min[0]) min[0] = valid.coords[i];
    if (valid.coords[i + 1] < min[1]) min[1] = valid.coords[i + 1];
    if (valid.coords[i + 2] < min[2]) min[2] = valid.coords[i + 2];
  }
  const origin = computeOrigin(min);

  const total = global.length / 3;
  return {
    positions: recenter(valid.coords, origin),
    origin,
    attributes: valid.attributes,
    excludedCount: valid.excludedCount,
    warning:
      valid.excludedCount > 0 ? exclusionWarning(valid.excludedCount, total) : undefined,
    witness: valid.witness,
  };
}

/**
 * The same policy for a loader that decodes straight into local coordinates
 * about an origin it already knows (LAS / LAZ take theirs from the header).
 * There is no origin to protect here, only the points and their attributes.
 */
export function sanitizeLocalCloud<A extends CloudAttributes>(
  positions: Float32Array,
  attributes: A,
  options: SanitizeOptions = {},
): SanitizedLocalCloud<A> {
  const total = positions.length / 3;
  const valid = compactValidRecords(positions, attributes, options.witness === true);
  return {
    positions: valid.coords,
    attributes: valid.attributes,
    excludedCount: valid.excludedCount,
    warning:
      valid.excludedCount > 0 ? exclusionWarning(valid.excludedCount, total) : undefined,
    witness: valid.witness,
  };
}

/**
 * Append a sanitation warning to a cloud's metadata, reusing the load-warning
 * channel the Scan Report already surfaces. Returns the metadata unchanged when
 * there is nothing to report, so a clean file carries no metadata it didn't
 * earn.
 */
export function withLoadWarning(
  metadata: CloudMetadata | undefined,
  warning: string | undefined,
): CloudMetadata | undefined {
  if (!warning) return metadata;
  return {
    ...metadata,
    loadWarnings: [...(metadata?.loadWarnings ?? []), warning],
  };
}
