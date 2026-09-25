/**
 * rays.ts — the ray builder (docs/observatory/SPEC.md §5.1, OB-RAY-01..05).
 *
 * `olv.observation.rays`, phase O3. Turns a gridded source's fitted angular
 * parameterisation (`acquisitionCoverage.ts`) plus its acquisition grid
 * (`OrganizedRange.ts`), or a posed unstructured source's positions, into
 * `ObservationRayChunk`s: one ray per grid cell for a gridded source, one ray
 * per record for a posed unstructured source. Traversal (O4) is not built
 * here; this module stops at the ray, per SPEC §10's O3 exit evidence.
 *
 * Pure and DOM-free (OB-INT-01): no DOM, `three` or `ui/` imports. Neither
 * builder reads a raw `.positions` array — both take an already-read
 * `Float32Array` from the caller (`sourcePositions(cloud)`, `pointFrames.ts`),
 * so this file never reaches into a `PointCloud` itself.
 */

import type { AcquisitionStation } from '../model/AcquisitionStations';
import { CellState, cellIndexOf, type CellStateValue, type OrganizedRangeFrame } from '../model/OrganizedRange';
import type { UpAxis } from '../model/acquisitionCoverage';

/**
 * One source's rays, structure-of-arrays, no per-ray JS object (OB-RAY-04):
 * ray `k`'s fields are `originIndex[k]`, `direction[3k..3k+2]`, `range[k]` and
 * `returnOffset[k]`.
 */
export interface ObservationRayChunk {
  /** Index into the station list this chunk's rays were fired from. */
  readonly originIndex: Uint16Array;
  /** Float32 direction, relative to the station's own Float64 origin. */
  readonly direction: Float32Array;
  /** Float32 range to the return; `NaN` for a no-return ray (OB-RAY-01). */
  readonly range: Float32Array;
  /** Offset into the multi-return table for this ray's returns (OB-RAY-03). */
  readonly returnOffset: Uint32Array;
}

/**
 * OB-RAY-05's deterministic-subsampling declaration: every k-th row and column
 * for gridded sources, or a hash threshold on record index for the rest. A
 * field built from a subsampled chunk carries basis `sampled`, never `full`.
 */
export type RaySubsampling =
  | { readonly kind: 'none' }
  | { readonly kind: 'grid-stride'; readonly k: number }
  | { readonly kind: 'hash-threshold'; readonly threshold: number };

/**
 * Bound on rays per `ObservationRayChunk` (OB-RAY-04). Matches the house
 * convention (`DEFAULT_CHUNK` in `src/render/measure/profileSectionLod.ts`
 * and `profileSectionExtract.ts`). One full chunk is 22 bytes/ray
 * (`originIndex` Uint16 2B + `direction` Float32×3 12B + `range` Float32 4B +
 * `returnOffset` Uint32 4B) × 65536 ≈ 1.375 MiB, a reasonable worker-transfer
 * unit.
 */
export const RAY_CHUNK_SIZE = 65536;

/**
 * OB-RAY-03's multi-return pass-through: every return of a multi-return ray,
 * addressed by the ray's own `returnOffset`/count, in ascending `returnIndex`
 * order (the order `buildCellReturns` already sorts a cell's CSR span into).
 *
 * Built from two buffers sized once from the source frame's own CSR span
 * (OB-RAY-04) and filled by index — never an unbounded per-return push,
 * whatever the return count of one station's frame.
 */
export interface ObservationReturnTable {
  /** Source-declared range of each return, in the same order as `countByRay` groups them. */
  readonly range: Float32Array;
  /** `countByRay[k]` returns belong to ray `k`, starting at that ray's own `returnOffset`. */
  readonly countByRay: Uint16Array;
}

/**
 * One source's built rays (OB-RAY-01/02/04): the returned and not-read ray
 * pools, the cells that were addressed but produced neither, and — only for a
 * source whose frame actually describes returns per cell — the multi-return
 * table OB-RAY-03 needs.
 */
export interface SourceRayBuild {
  /** Index into the station list, echoed into every built ray's `originIndex`. */
  readonly sourceIndex: number;
  /** `VALID_RETURN` and `NO_RETURN` rays (finite range and `NaN` range respectively). */
  readonly returnedChunks: readonly ObservationRayChunk[];
  /** `NOT_DECODED` rays only: a cell this session did not read. */
  readonly notReadChunks: readonly ObservationRayChunk[];
  /**
   * `SOURCE_INVALID` + `SOURCE_RECORD_MISSING` cells: no ray, but counted.
   * A gridded `VALID_RETURN` cell whose resolved range is non-positive or
   * non-finite (a degenerate station pose or position) is counted here too,
   * rather than emitting a ray a `NaN` range would read as `NO_RETURN`.
   */
  readonly excludedCount: number;
  readonly subsampling: RaySubsampling;
  /** Present only when the source frame carries per-cell CSR return data. */
  readonly returnTable?: ObservationReturnTable;
}

/**
 * A gridded setup's fitted angular parameterisation: the four fields of
 * `AcquisitionCoverageIndex.setups[i]` a direction actually needs
 * (`acquisitionCoverage.ts`'s `SetupCoverage`, not imported by name since it
 * is module-private, also carries the setup's own `originH1`/`originH2`/
 * `originV`, which a RAY DIRECTION has no use for — a direction is an
 * orientation, not a position).
 *
 * The direction this produces is already a WORLD-frame unit vector: the fit
 * itself is anchored to the station's own origin and its own observed
 * azimuth/polar baseline, so no separate pose-rotation step is applied on top
 * (the discrepancy this resolves is recorded in the O3 ledger entry).
 */
export interface GriddedRayCoverage {
  /** Azimuth of column 0, radians. */
  readonly azimuth0: number;
  /** Radians per column. */
  readonly azimuthStep: number;
  /** Polar angle of row 0, radians, measured from the `v` axis. */
  readonly polar0: number;
  /** Radians per row. */
  readonly polarStep: number;
  /** Default `'z'`, matching `acquisitionCoverage.ts`'s own default. */
  readonly upAxis?: UpAxis;
}

/**
 * The source-local positions a gridded build falls back on when a cell's
 * range is not already declared (`geometricRange` for a single-return frame,
 * `returnSourceRange` for a multi-return one) — structured E57 and organized
 * PCD, whose frames never carry `geometricRange` (PTX always does).
 */
export interface GriddedRayPositions {
  /** `sourcePositions(cloud)` — Float32, source-local. Named to keep `lint:position-access` reading a real `.positions` property access, not this field. */
  readonly sourceLocal: Float32Array;
  /** The cloud's Float64 world offset: `world = sourceLocal + cloudSourceOrigin`. */
  readonly cloudSourceOrigin: readonly [number, number, number];
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];

function subtract3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** A direction scratch a caller allocates once and reuses across its whole ray loop (OB-RAY-04): no per-ray object. */
interface DirectionScratch {
  x: number;
  y: number;
  z: number;
}

/**
 * Writes the world-frame unit direction for one gridded ray into `out`, from
 * its fitted azimuth/polar, in the same `(h1, h2, v)` axes
 * `acquisitionCoverage.ts`'s `project()` uses, converted back to `(x, y, z)`
 * by that function's inverse. Mutates `out` instead of returning a fresh
 * array, so a caller's per-cell loop allocates nothing.
 */
function writeDirectionFromAngles(azimuth: number, polar: number, upAxis: UpAxis, out: DirectionScratch): void {
  const sinPolar = Math.sin(polar);
  const h1 = sinPolar * Math.cos(azimuth);
  const h2 = sinPolar * Math.sin(azimuth);
  const v = Math.cos(polar);
  if (upAxis === 'y') {
    out.x = h1;
    out.y = v;
    out.z = h2;
  } else {
    out.x = h1;
    out.y = h2;
    out.z = v;
  }
}

/**
 * OB-RAY-05's fixed, documented hash of a record index into `[0, 1)`. A
 * MurmurHash3-style 32-bit finalizer mix: deterministic and pure, so the same
 * record index always lands on the same side of a threshold across reruns,
 * chunk orders and machines (OB-INV-07).
 */
function hashUnit(record: number): number {
  let x = (record ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/** Accumulates rays into bounded `ObservationRayChunk`s (OB-RAY-04). */
class RayChunkBuilder {
  private readonly chunks: ObservationRayChunk[] = [];
  private originIndex = new Uint16Array(RAY_CHUNK_SIZE);
  private direction = new Float32Array(RAY_CHUNK_SIZE * 3);
  private range = new Float32Array(RAY_CHUNK_SIZE);
  private returnOffset = new Uint32Array(RAY_CHUNK_SIZE);
  private count = 0;

  push(sourceIndex: number, dx: number, dy: number, dz: number, range: number, returnOffset: number): void {
    const k = this.count;
    this.originIndex[k] = sourceIndex;
    this.direction[k * 3] = dx;
    this.direction[k * 3 + 1] = dy;
    this.direction[k * 3 + 2] = dz;
    this.range[k] = range;
    this.returnOffset[k] = returnOffset;
    this.count++;
    if (this.count === RAY_CHUNK_SIZE) this.flush();
  }

  private flush(): void {
    if (this.count === 0) return;
    const n = this.count;
    this.chunks.push({
      originIndex: this.originIndex.slice(0, n),
      direction: this.direction.slice(0, n * 3),
      range: this.range.slice(0, n),
      returnOffset: this.returnOffset.slice(0, n),
    });
    this.originIndex = new Uint16Array(RAY_CHUNK_SIZE);
    this.direction = new Float32Array(RAY_CHUNK_SIZE * 3);
    this.range = new Float32Array(RAY_CHUNK_SIZE);
    this.returnOffset = new Uint32Array(RAY_CHUNK_SIZE);
    this.count = 0;
  }

  finish(): readonly ObservationRayChunk[] {
    this.flush();
    return this.chunks;
  }
}

/** The Float64 range from a station's local position to a record's position, before recentring. */
function rangeFromPosition(record: number, positions: GriddedRayPositions | undefined, stationLocal: Vec3 | null): number {
  if (!positions || !stationLocal) {
    throw new Error(
      `buildGriddedSourceRays: record ${record} has no declared range and no fallback positions were supplied`,
    );
  }
  const dx = positions.sourceLocal[record * 3]! - stationLocal[0];
  const dy = positions.sourceLocal[record * 3 + 1]! - stationLocal[1];
  const dz = positions.sourceLocal[record * 3 + 2]! - stationLocal[2];
  return Math.hypot(dx, dy, dz);
}

/** One CSR return's range: the source's own declaration, or the position fallback. */
function resolveReturnRange(
  frame: OrganizedRangeFrame,
  entry: number,
  positions: GriddedRayPositions | undefined,
  stationLocal: Vec3 | null,
): number {
  const declared = frame.returnSourceRange?.[entry];
  if (declared !== undefined && Number.isFinite(declared)) return declared;
  const record = frame.returnRecord![entry]!;
  return rangeFromPosition(record, positions, stationLocal);
}

/** A single-return cell's range: `geometricRange`, or the position fallback. */
function resolvePrimaryRange(
  frame: OrganizedRangeFrame,
  idx: number,
  positions: GriddedRayPositions | undefined,
  stationLocal: Vec3 | null,
): number {
  const declared = frame.geometricRange?.[idx];
  if (declared !== undefined && Number.isFinite(declared)) return declared;
  const record = frame.cellToRecord[idx]!;
  if (record < 0) {
    throw new Error(`buildGriddedSourceRays: VALID_RETURN cell at index ${idx} carries no record identity`);
  }
  return rangeFromPosition(record, positions, stationLocal);
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

/**
 * OB-RAY-01: one ray per cell of a gridded source (PTX, structured E57,
 * organized PCD with an origin).
 *
 * `VALID_RETURN` gives a returned ray at its declared or derived range,
 * unless that range is non-positive or non-finite, which excludes the cell
 * instead (a derived range's own hypot can degenerate on a NaN station pose
 * or a record coincident with it, and the alternative — a `NaN`-range
 * `VALID_RETURN` ray — would be indistinguishable from a legitimate
 * `NO_RETURN` one downstream). `NO_RETURN` gives a returned ray with `NaN`
 * range. `NOT_DECODED` gives a not-read ray. `SOURCE_INVALID` and
 * `SOURCE_RECORD_MISSING` give no ray, and are counted in `excludedCount`.
 * OB-RAY-05's `grid-stride` subsampling is applied before any of that: a
 * skipped cell contributes to neither the exclusion count nor either ray
 * pool.
 *
 * `positions` is required only when some `VALID_RETURN` cell has no declared
 * range of its own (`geometricRange` absent for the cell, or a multi-return
 * entry with no declared `returnSourceRange`) — PTX always declares
 * `geometricRange`; structured E57 and organized PCD do not.
 */
export function buildGriddedSourceRays(
  frame: OrganizedRangeFrame,
  station: AcquisitionStation,
  sourceIndex: number,
  coverage: GriddedRayCoverage,
  subsampling: RaySubsampling,
  positions?: GriddedRayPositions,
): SourceRayBuild {
  const upAxis: UpAxis = coverage.upAxis ?? 'z';
  const { width, height } = frame;
  const hasReturnTable = Boolean(frame.returnCellStart && frame.returnRecord);
  const stride = subsampling.kind === 'grid-stride' ? subsampling.k : null;
  const stationLocal = positions ? subtract3(station.pose.worldTranslation, positions.cloudSourceOrigin) : null;

  const returned = new RayChunkBuilder();
  const notRead = new RayChunkBuilder();
  const direction: DirectionScratch = { x: 0, y: 0, z: 0 };

  // Bounded, single-allocation return-table buffers (OB-RAY-04), sized once
  // from the frame's own CSR endpoint — an exact upper bound on how many
  // returns this walk can ever address, since subsampling and state
  // filtering only shrink it further — and filled by index, never an
  // unbounded push-then-Array.from intermediate.
  const returnRangeCapacity = hasReturnTable ? frame.returnCellStart![frame.returnCellStart!.length - 1]! : 0;
  const returnTableRanges = hasReturnTable ? new Float32Array(returnRangeCapacity) : undefined;
  const returnTableCounts = hasReturnTable ? new Uint16Array(width * height) : undefined;
  let returnTableCountLength = 0;

  let returnCursor = 0;
  let excludedCount = 0;

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (stride !== null && (row % stride !== 0 || column % stride !== 0)) continue;

      const idx = cellIndexOf(row, column, width);
      const state = frame.cellState[idx] as CellStateValue;

      if (state === CellState.SOURCE_INVALID || state === CellState.SOURCE_RECORD_MISSING) {
        excludedCount++;
        continue;
      }

      const azimuth = coverage.azimuth0 + coverage.azimuthStep * column;
      const polar = coverage.polar0 + coverage.polarStep * row;
      writeDirectionFromAngles(azimuth, polar, upAxis, direction);

      if (state === CellState.NOT_DECODED) {
        notRead.push(sourceIndex, direction.x, direction.y, direction.z, Number.NaN, returnCursor);
        continue;
      }

      if (state === CellState.NO_RETURN) {
        returned.push(sourceIndex, direction.x, direction.y, direction.z, Number.NaN, returnCursor);
        if (hasReturnTable) returnTableCounts![returnTableCountLength++] = 0;
        continue;
      }

      // VALID_RETURN.
      const offset = returnCursor;
      let range: number;
      if (hasReturnTable) {
        const start = frame.returnCellStart![idx]!;
        const end = frame.returnCellStart![idx + 1]!;
        const count = end - start;
        if (count <= 0) {
          throw new Error(`buildGriddedSourceRays: VALID_RETURN cell (${row},${column}) has no CSR return entries`);
        }
        range = resolveReturnRange(frame, start, positions, stationLocal);
        // A degenerate primary range (NaN station pose, or a record position
        // coincident with the station) must not reach a VALID_RETURN ray,
        // where it would read as a legitimate NO_RETURN (OB-RAY-01) — the
        // cell is excluded instead, and the return table is left untouched
        // for it.
        if (!(range > 0) || !Number.isFinite(range)) {
          excludedCount++;
          continue;
        }
        for (let entry = start; entry < end; entry++) {
          returnTableRanges![returnCursor + (entry - start)] = resolveReturnRange(frame, entry, positions, stationLocal);
        }
        returnTableCounts![returnTableCountLength++] = count;
        returnCursor += count;
      } else {
        range = resolvePrimaryRange(frame, idx, positions, stationLocal);
        // Same degenerate-range guard as the multi-return branch above.
        if (!(range > 0) || !Number.isFinite(range)) {
          excludedCount++;
          continue;
        }
      }
      returned.push(sourceIndex, direction.x, direction.y, direction.z, range, offset);
    }
  }

  return {
    sourceIndex,
    returnedChunks: returned.finish(),
    notReadChunks: notRead.finish(),
    excludedCount,
    subsampling,
    ...(hasReturnTable
      ? {
          returnTable: {
            range: returnTableRanges!.slice(0, returnCursor),
            countByRay: returnTableCounts!.slice(0, returnTableCountLength),
          },
        }
      : {}),
  };
}

/**
 * OB-RAY-02: one ray per record of a posed unstructured source, direction
 * `normalize(hit - origin)` and range `‖hit - origin‖`, computed in Float64 in
 * the station's own frame before any recentring (`docs/coordinate-precision.md`)
 * — `position - (station.worldTranslation - cloudSourceOrigin)`, narrowed to
 * Float32 only on write to the chunk.
 *
 * No no-return rays (`SourceRayBuild.notReadChunks` is always empty): an
 * unstructured decode carries no per-point return/decode state to distinguish
 * one. OB-RAY-05's `hash-threshold` subsampling is applied per record, before
 * any ray is built for it.
 */
export function buildUnstructuredSourceRays(
  positions: Float32Array,
  station: AcquisitionStation,
  sourceIndex: number,
  cloudSourceOrigin: Vec3,
  subsampling: RaySubsampling,
): SourceRayBuild {
  const threshold = subsampling.kind === 'hash-threshold' ? subsampling.threshold : null;
  const stationLocal = subtract3(station.pose.worldTranslation, cloudSourceOrigin);

  const returned = new RayChunkBuilder();
  let excludedCount = 0;

  for (let record = station.recordRange.start; record < station.recordRange.end; record++) {
    if (threshold !== null && hashUnit(record) >= threshold) continue;

    const dx = positions[record * 3]! - stationLocal[0];
    const dy = positions[record * 3 + 1]! - stationLocal[1];
    const dz = positions[record * 3 + 2]! - stationLocal[2];
    const range = Math.hypot(dx, dy, dz);
    // A record exactly at the station has no direction to normalize.
    if (!(range > 0) || !Number.isFinite(range)) {
      excludedCount++;
      continue;
    }
    returned.push(sourceIndex, dx / range, dy / range, dz / range, range, 0);
  }

  return {
    sourceIndex,
    returnedChunks: returned.finish(),
    notReadChunks: [],
    excludedCount,
    subsampling,
  };
}
