/**
 * scanPrecision.ts — read the active scan's in-memory quantization off the
 * live app state, once, in one place.
 *
 * The measurement and the policy live in `geo/inMemoryPrecision.ts` (pure). This
 * module is the reader: it knows which origin and which extent each of the two
 * loaded shapes actually holds, so no caller has to remember.
 *
 *  - A static `PointCloud` recentres on its immutable `sourceOrigin`, and
 *    `bounds()` is already the local residual set.
 *  - A streaming COPC/EPT source recentres every node on `renderOrigin`, and
 *    `dataBounds()` is the TIGHT local data extent. `localBounds()` is the
 *    octree root cube and would over-report the reach on the short axes.
 *
 * Both are handed to the estimate as an already-chosen origin, because that is
 * what they are: the loader's `floor(min)` for a static cloud, the floored cube
 * centre for a streaming one. Re-deriving `floor(min)` here would model the
 * streaming case wrong (its residuals straddle zero) and silently under-report.
 *
 * WHEN THE DECLARED BOX IS NOT A BOX. `dataBounds()` is the LAS header's
 * min/max, and real files ship that field zeroed: two public LAS 1.4 datasets
 * in the corpus declare min = max = 0 on every axis while carrying 15.2 M and
 * 9.6 M points (confirmed against the same files with WhiteboxTools
 * `lidar_info`, so it is the file's claim and not a parse). Read straight, that
 * box breaks this reader in both directions. On a georeferenced source it puts
 * the whole extent one render origin away from zero, so the reach reads as the
 * UTM northing (4,644,804 measured) and a good dataset is refused. On a
 * local-frame source it collapses to the origin, so the reach reads 0, the
 * worst-case step reads 1.4e-45 m, and a permit is GRANTED from no evidence at
 * all. The second is the one that matters: this permit exists to refuse work
 * the numbers cannot support.
 *
 * So a box is read only when it is readable (finite corners, some span on some
 * axis). A streaming source that fails that test falls back to `localBounds()`,
 * the octree root cube, which is a containment guarantee rather than a claim:
 * every point is inside it by construction, COPC refuses a non-positive
 * half-size at header parse (`io/copc/copcHeader.ts`), and it is already the
 * box the scene is framed in. The reach it yields is an upper bound on the real
 * one, so the resulting figure can over-report the step and never under-report
 * it. When neither box is readable the frame is INDETERMINATE and the permit is
 * refused outright, because substituting a number there would be the same
 * fabrication in a quieter form.
 *
 * No DOM, no three.js. The two cloud shapes are structural, so this is unit
 * tested against plain objects rather than a mounted viewer.
 */

import { isLinearUnitKnown } from '../geo/CoordinateTypes';
import {
  estimateInMemoryPrecision,
  resolvePrecisionPermit,
  type InMemoryPrecision,
  type PrecisionPermit,
  type PrecisionPermitRefused,
} from '../geo/inMemoryPrecision';

/** An axis-aligned box as `[minX, minY, minZ, maxX, maxY, maxZ]`. */
type Box6 = readonly [number, number, number, number, number, number];

type Vec3 = readonly [number, number, number];

/** The part of a static `PointCloud` this reader needs. */
export interface PrecisionStaticCloud {
  readonly sourceOrigin: readonly [number, number, number];
  bounds(): { min: [number, number, number]; max: [number, number, number] };
}

/** The part of a `StreamingSource` this reader needs. */
export interface PrecisionStreamingCloud {
  readonly renderOrigin: readonly [number, number, number];
  dataBounds(): Box6;
  /**
   * The octree root cube, origin-shifted exactly as `dataBounds()` is. Read
   * ONLY when the declared data box is unreadable, as the containment bound
   * described in the module header; it over-reports the reach on the short
   * axes, so it is never the first choice.
   */
  localBounds?: () => Box6;
}

/** The unit facts, in the shape both `CrsInfo` and `ResolvedCrs` already carry. */
export interface PrecisionCrsFacts {
  readonly linearUnit?: string;
  readonly linearUnitToMetres?: number;
  readonly verticalUnitToMetres?: number;
}

export interface ScanPrecisionInputs {
  /** The active static cloud, when one is loaded. Preferred over `streaming`. */
  readonly cloud?: PrecisionStaticCloud | null;
  /** The streaming source, when the active scan is COPC/EPT. */
  readonly streaming?: PrecisionStreamingCloud | null;
  /** The effective CRS; `null` fails closed to "no metre figure". */
  readonly crs?: PrecisionCrsFacts | null;
  /** Override the refusal budget, in metres. Omit for the documented default. */
  readonly budgetMetres?: number;
}

/**
 * The in-memory quantization of the active scan, or `null` when there is no
 * frame to measure: nothing loaded, or a loaded scan whose declared boxes are
 * all unreadable. `null` is "no figure", not "no error" — a caller must not
 * read it as a pass, and a caller that needs the gate must read
 * {@link scanPrecisionPermit}, which refuses the second case explicitly.
 */
export function scanPrecision(inputs: ScanPrecisionInputs): InMemoryPrecision | null {
  const resolved = resolveLocalFrame(inputs);
  return resolved.kind === 'frame' ? precisionOfFrame(resolved.frame, inputs) : null;
}

/** The estimate for an already-resolved frame. */
function precisionOfFrame(frame: LocalFrame, inputs: ScanPrecisionInputs): InMemoryPrecision {
  // The linear unit gate is the canonical one every metric surface uses, so a
  // CRS carrying the inert placeholder `linearUnitToMetres: 1` for an unknown
  // unit yields no metre figure here either.
  const unitKnown = isLinearUnitKnown(inputs.crs ?? null);
  const [origin, min, max] = frame;
  return estimateInMemoryPrecision({
    // The extent is lifted back into the source frame so the estimate reports
    // the real origin; the reach it derives is identical either way.
    extent: {
      min: [min[0] + origin[0], min[1] + origin[1], min[2] + origin[2]],
      max: [max[0] + origin[0], max[1] + origin[1], max[2] + origin[2]],
    },
    strategy: { kind: 'shared-origin', origin },
    unit: {
      linearUnitKnown: unitKnown,
      linearUnitToMetres: inputs.crs?.linearUnitToMetres ?? 1,
      verticalUnitToMetres: inputs.crs?.verticalUnitToMetres,
    },
  });
}

/**
 * Mint the precision permit for the active scan, or `null` when nothing is
 * loaded. A caller that holds `null` has no scan to gate and must decide on
 * its own grounds; a caller that holds a permit must honour `ok === false`.
 *
 * A loaded scan whose boxes are all unreadable returns a REFUSED permit, not
 * `null`: `null` is read downstream as "no precision term" and passes
 * (`export/exportManifest.ts` blocks only on `precision.ok === false`), so
 * handing it back for an unmeasurable frame would reopen the hole this reader
 * closes.
 */
export function scanPrecisionPermit(inputs: ScanPrecisionInputs): PrecisionPermit | null {
  const resolved = resolveLocalFrame(inputs);
  if (resolved.kind === 'absent') return null;
  if (resolved.kind === 'indeterminate') return indeterminateFramePermit(resolved.origin);
  return resolvePrecisionPermit(
    precisionOfFrame(resolved.frame, inputs),
    inputs.budgetMetres !== undefined ? { budgetMetres: inputs.budgetMetres } : {},
  );
}

type LocalFrame = [Vec3, Vec3, Vec3];

/**
 * What reading the loaded shape produced: a frame to measure, a loaded scan
 * with no readable box, or nothing loaded at all. The last two are separate
 * answers because only one of them is a refusal.
 */
type FrameResolution =
  | { readonly kind: 'frame'; readonly frame: LocalFrame }
  | { readonly kind: 'indeterminate'; readonly origin: Vec3 }
  | { readonly kind: 'absent' };

/**
 * Whether a declared box can be read as an extent at all: every corner finite,
 * and some span on at least one axis.
 *
 * "At least one axis" rather than "all three" on purpose. A dataset can be flat
 * in Z and still have a real extent, and its frame is measurable; what is not
 * measurable is a box that is a single point, which no cloud with points in it
 * can honestly declare.
 */
function isReadableBox(b: Box6): boolean {
  for (let i = 0; i < 6; i++) {
    if (!Number.isFinite(b[i])) return false;
  }
  return b[3] > b[0] || b[4] > b[1] || b[5] > b[2];
}

const frameOf = (origin: Vec3, b: Box6): FrameResolution => ({
  kind: 'frame',
  frame: [origin, [b[0], b[1], b[2]], [b[3], b[4], b[5]]],
});

/** The origin and the LOCAL extent the loaded shape actually holds. */
function resolveLocalFrame(inputs: ScanPrecisionInputs): FrameResolution {
  const cloud = inputs.cloud;
  if (cloud) {
    const b = cloud.bounds();
    const o = cloud.sourceOrigin;
    const origin: Vec3 = [o[0], o[1], o[2]];
    const box: Box6 = [b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]];
    // A static cloud's bounds are scanned off the decoded positions, so there
    // is no second box to fall back to: an unreadable one means the buffer
    // itself holds no extent.
    return isReadableBox(box) ? frameOf(origin, box) : { kind: 'indeterminate', origin };
  }
  const streaming = inputs.streaming;
  if (streaming) {
    const o = streaming.renderOrigin;
    const origin: Vec3 = [o[0], o[1], o[2]];
    const data = streaming.dataBounds();
    if (isReadableBox(data)) return frameOf(origin, data);
    const cube = streaming.localBounds?.();
    if (cube && isReadableBox(cube)) return frameOf(origin, cube);
    return { kind: 'indeterminate', origin };
  }
  return { kind: 'absent' };
}

/**
 * The refusal for a scan whose frame cannot be established.
 *
 * The estimate is carried so the refusal still says which origin it was reading
 * from, and it is built WITHOUT a unit basis: there is no extent to convert, so
 * no metre figure is minted for one and the grade resolves to `unknown`. The
 * reasons name the file field at fault, because the remedy is to the file.
 */
function indeterminateFramePermit(origin: Vec3): PrecisionPermitRefused {
  const precision = estimateInMemoryPrecision({
    extent: { min: origin, max: origin },
    strategy: { kind: 'shared-origin', origin },
  });
  return {
    ok: false,
    precision,
    reasons: [
      'This scan declares no extent: its bounding box collapses to a single point, '
      + 'so there is no distance from the local origin to put through the Float32 step.',
      'A precision figure taken from that box would describe the declared box rather '
      + 'than the data, so no permit is issued for it.',
      'Check the declared bounding box in the file header (WhiteboxTools `lidar_info` '
      + 'and PDAL `info` both report it), rewrite it from the point records, and re-run.',
    ],
  };
}
