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
 * No DOM, no three.js. The two cloud shapes are structural, so this is unit
 * tested against plain objects rather than a mounted viewer.
 */

import { isLinearUnitKnown } from '../geo/CoordinateTypes';
import {
  estimateInMemoryPrecision,
  resolvePrecisionPermit,
  type InMemoryPrecision,
  type PrecisionPermit,
} from '../geo/inMemoryPrecision';

/** The part of a static `PointCloud` this reader needs. */
export interface PrecisionStaticCloud {
  readonly sourceOrigin: readonly [number, number, number];
  bounds(): { min: [number, number, number]; max: [number, number, number] };
}

/** The part of a `StreamingSource` this reader needs. */
export interface PrecisionStreamingCloud {
  readonly renderOrigin: readonly [number, number, number];
  dataBounds(): readonly [number, number, number, number, number, number];
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
 * The in-memory quantization of the active scan, or `null` when nothing is
 * loaded. `null` is "no scan", not "no error" — a caller must not read it as a
 * pass.
 */
export function scanPrecision(inputs: ScanPrecisionInputs): InMemoryPrecision | null {
  const frame = localFrameOf(inputs);
  if (!frame) return null;

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
 */
export function scanPrecisionPermit(inputs: ScanPrecisionInputs): PrecisionPermit | null {
  const precision = scanPrecision(inputs);
  if (!precision) return null;
  return resolvePrecisionPermit(
    precision,
    inputs.budgetMetres !== undefined ? { budgetMetres: inputs.budgetMetres } : {},
  );
}

type LocalFrame = [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/** The origin and the LOCAL extent the loaded shape actually holds. */
function localFrameOf(inputs: ScanPrecisionInputs): LocalFrame | null {
  const cloud = inputs.cloud;
  if (cloud) {
    const b = cloud.bounds();
    const o = cloud.sourceOrigin;
    return [[o[0], o[1], o[2]], b.min, b.max];
  }
  const streaming = inputs.streaming;
  if (streaming) {
    const b = streaming.dataBounds();
    const o = streaming.renderOrigin;
    return [
      [o[0], o[1], o[2]],
      [b[0], b[1], b[2]],
      [b[3], b[4], b[5]],
    ];
  }
  return null;
}
