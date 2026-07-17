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
}

/** A cloud cleared of unplaceable points, for positions that are already local. */
export interface SanitizedLocalCloud<A extends CloudAttributes> {
  positions: Float32Array;
  attributes: A;
  excludedCount: number;
  warning?: string;
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
): { coords: C; attributes: A; excludedCount: number } {
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
  if (kept === count) return { coords, attributes, excludedCount: 0 };

  if (kept === 0) {
    throw new LoadError(
      'malformed-file',
      `None of this file's ${count} points can be placed in space — every one ` +
        `carries a non-finite x/y/z (NaN or ±Infinity).`,
    );
  }

  const keptCoords = like(coords, kept * 3);
  for (const slot of slots) slot.out = like(slot.src, kept * slot.width);

  // One loop, one index: positions and every attribute advance together, which
  // is what makes the lockstep guarantee structural rather than a convention
  // each caller has to remember.
  let w = 0;
  for (let i = 0; i < count; i++) {
    const x = coords[i * 3];
    const y = coords[i * 3 + 1];
    const z = coords[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
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
  return { coords: keptCoords, attributes: filtered, excludedCount: count - kept };
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
): SanitizedCloud<A> {
  const valid = compactValidRecords(global, attributes);
  if (valid.coords.length === 0) {
    return {
      positions: new Float32Array(0),
      origin: [0, 0, 0],
      attributes: valid.attributes,
      excludedCount: 0,
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
): SanitizedLocalCloud<A> {
  const total = positions.length / 3;
  const valid = compactValidRecords(positions, attributes);
  return {
    positions: valid.coords,
    attributes: valid.attributes,
    excludedCount: valid.excludedCount,
    warning:
      valid.excludedCount > 0 ? exclusionWarning(valid.excludedCount, total) : undefined,
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
