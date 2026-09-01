/**
 * liveDtmDescriptor.ts
 *
 * ONE machine-readable descriptor of the DTM method the viewer actually
 * delivers, plus a SHA-256 digest over its method-behaviour fields so any
 * scientific-behaviour change moves the digest. External validation and export
 * paths read this instead of re-deriving the method from prose, and a reader
 * can compare a stamped `dtmMethodDigest` against a fresh resolve to prove the
 * delivered method has not silently drifted.
 *
 * Every value below is RESOLVED from the production source of truth, not
 * re-typed: the method id/version from {@link METHOD_REGISTRY}, the void-fill
 * method and extrapolation guard from `surfaceFromRaster.ts`
 * ({@link LIVE_INTERPOLATION}, {@link LIVE_EXTRAPOLATION_GUARD}), the per-cell
 * aggregation and the trusted-classification decision from the documented
 * production path in `analyseContours.computeTerrainCore`. Where a value is a
 * call-site choice rather than an exported constant, the comment cites the
 * file:line it was read from.
 *
 * The digest covers METHOD BEHAVIOUR only. Per-dataset inputs (cell size, CRS,
 * datum, geoid) are NOT method behaviour — they belong to a run, not the
 * method — so they are carried on the descriptor for context but held OUT of
 * the digest.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic. Kept dependency-light
 * and imported only from validation/export paths (never from an eager module),
 * so it stays out of the index chunk.
 */

import { METHOD_REGISTRY } from './methodRegistry';
import { canonicalize, sha256 } from '../render/measure/auditLog';
import {
  LIVE_INTERPOLATION,
  LIVE_EXTRAPOLATION_GUARD,
} from '../terrain/ground/surfaceFromRaster';
import {
  LIVE_DTM_AGGREGATION,
  ASPRS_GROUND_CLASS,
} from '../terrain/ground/liveDtmConstants';

/**
 * The registry id of the delivered DTM method. Stable legacy token; the shipped
 * fill is geodesic (see METHOD_REGISTRY['olv.dtm.idw-fill'] and
 * surfaceFromRaster.LIVE_INTERPOLATION). Resolving through the registry means
 * the method version tracks the registry's behaviour-versioning contract.
 */
const LIVE_DTM_METHOD_ID = 'olv.dtm.idw-fill' as const;

/**
 * Vertical axis convention of the delivered grid. Read from
 * `analyseContours.ts:678` — `params.verticalAxis ?? 'z'`.
 */
const LIVE_VERTICAL_AXIS = 'z' as const;

/**
 * Sampling convention: grid values sit at cell CENTRES and are read back with
 * bilinear interpolation (`holdoutRmse.ts:359`, `dtmSurfaceModel.ts:48,95`).
 */
const LIVE_SAMPLING_CONVENTION = 'bilinear-cell-centres' as const;

export type DtmAggregationName = 'mean' | 'min' | 'median' | 'percentile' | 'robust';

/** Extrapolation guard: one-sided fills demoted toward gap. */
export interface ExtrapolationGuardDescriptor {
  readonly radiusCells: number;
  readonly penalty: number;
}

/**
 * The canonical description of the delivered DTM method. The `method*` fields
 * are method behaviour and feed {@link dtmMethodDigest}; the `run*` /
 * per-dataset fields are context and do NOT.
 */
export interface LiveDtmDescriptor {
  /** Registry method id, e.g. `olv.dtm.idw-fill`. */
  readonly methodId: string;
  /** Registry method version (bumped when behaviour changes). */
  readonly methodVersion: number;
  /** Per-cell ground-return aggregation of the delivered surface. */
  readonly aggregation: DtmAggregationName;
  /** Grid vertical axis convention. */
  readonly verticalAxis: 'z' | 'y';
  /** True: the production path trusts an authoritative ASPRS class-2 set. */
  readonly trustGroundClassification: boolean;
  /** ASPRS code trusted as ground. */
  readonly groundClass: number;
  /**
   * Whether the blunder-only despike runs. In the trusted-classification
   * production path it is OFF (`analyseContours.ts:787` —
   * `const despikeApplied = !trust.trust`), so authoritative steep ground is
   * never void-filled as a spike.
   */
  readonly despikeApplied: boolean;
  /** Void-fill method (`geodesic`). */
  readonly interpolation: typeof LIVE_INTERPOLATION;
  /** One-sided-fill demotion guard. */
  readonly extrapolationGuard: ExtrapolationGuardDescriptor;
  /** Metres per source horizontal unit; method default 1 (identity). */
  readonly horizontalUnitToMetres: number;
  /** Metres per source vertical unit; method default 1 (identity). */
  readonly verticalUnitToMetres: number;
  /** Grid sampling convention. */
  readonly samplingConvention: typeof LIVE_SAMPLING_CONVENTION;
  /**
   * Caller-supplied cell size in metres, or null when unbound. This is a
   * per-RUN input (`analyseContours` reads `params.cellSizeM` at the raster
   * grid, e.g. `analyseContours.ts:772`), NOT a fixed method constant — hence
   * `cellSizeSource: 'caller-supplied'` and its exclusion from the digest.
   */
  readonly cellSizeM: number | null;
  /** Provenance of the cell size: always caller-supplied in the live path. */
  readonly cellSizeSource: 'caller-supplied' | 'fixed';
}

export interface ResolveLiveDtmOptions {
  /**
   * Caller-supplied cell size (metres) for context. Optional: the method is
   * defined independently of it; it is recorded but excluded from the digest.
   */
  readonly cellSizeM?: number | null;
  /** Override the identity horizontal unit scale (per-dataset). */
  readonly horizontalUnitToMetres?: number;
  /** Override the identity vertical unit scale (per-dataset). */
  readonly verticalUnitToMetres?: number;
  /**
   * Whether the run trusts an authoritative ASPRS class-2 set. Defaults true —
   * the production live path. The blunder-only despike is its complement
   * (`analyseContours.ts:790` — `const despikeApplied = !trust.trust`), so the
   * two descriptor fields are derived from this one input rather than set apart.
   */
  readonly trustGroundClassification?: boolean;
}

/**
 * Resolve the descriptor of the DTM method the viewer delivers. Everything but
 * the genuinely caller-supplied values (cell size, unit scales) is derived from
 * the production source of truth.
 */
export function resolveLiveDtmDescriptor(
  opts: ResolveLiveDtmOptions = {},
): LiveDtmDescriptor {
  const entry = METHOD_REGISTRY[LIVE_DTM_METHOD_ID];
  if (!entry) {
    throw new Error(`liveDtmDescriptor: method ${LIVE_DTM_METHOD_ID} missing from registry`);
  }
  // Trust and despike are one decision, not two literals: the despike is the
  // complement of trust (`analyseContours.ts:790`). Default true keeps the
  // production live path (trust=true, despike=false).
  const trust = opts.trustGroundClassification ?? true;
  return {
    methodId: entry.id,
    methodVersion: entry.version,
    // Imported from the production source of truth (shared constants module),
    // never mirrored — so a change to the delivered aggregation moves the digest.
    aggregation: LIVE_DTM_AGGREGATION,
    verticalAxis: LIVE_VERTICAL_AXIS,
    trustGroundClassification: trust,
    groundClass: ASPRS_GROUND_CLASS,
    despikeApplied: !trust,
    interpolation: LIVE_INTERPOLATION,
    extrapolationGuard: {
      radiusCells: LIVE_EXTRAPOLATION_GUARD.radiusCells,
      penalty: LIVE_EXTRAPOLATION_GUARD.penalty,
    },
    horizontalUnitToMetres: opts.horizontalUnitToMetres ?? 1,
    verticalUnitToMetres: opts.verticalUnitToMetres ?? 1,
    samplingConvention: LIVE_SAMPLING_CONVENTION,
    cellSizeM: opts.cellSizeM ?? null,
    cellSizeSource: 'caller-supplied',
  };
}

/**
 * The method-behaviour projection of a descriptor: exactly the fields whose
 * change alters the delivered surface's method. Per-run / per-dataset context
 * (cellSizeM, cellSizeSource) is deliberately excluded, as are CRS/datum/geoid
 * which never appear on the descriptor at all.
 */
function methodBehaviourFields(d: LiveDtmDescriptor): Record<string, unknown> {
  return {
    methodId: d.methodId,
    methodVersion: d.methodVersion,
    aggregation: d.aggregation,
    verticalAxis: d.verticalAxis,
    trustGroundClassification: d.trustGroundClassification,
    groundClass: d.groundClass,
    despikeApplied: d.despikeApplied,
    interpolation: d.interpolation,
    extrapolationGuard: {
      radiusCells: d.extrapolationGuard.radiusCells,
      penalty: d.extrapolationGuard.penalty,
    },
    horizontalUnitToMetres: d.horizontalUnitToMetres,
    verticalUnitToMetres: d.verticalUnitToMetres,
    samplingConvention: d.samplingConvention,
  };
}

/**
 * SHA-256 (hex) over a canonical, key-sorted serialization of the descriptor's
 * method-behaviour fields. Same behaviour ⇒ same digest, regardless of field
 * order or per-dataset context. Uses the repo's browser-safe synchronous
 * `sha256` (no `node:crypto`).
 */
export function dtmMethodDigest(descriptor: LiveDtmDescriptor): string {
  return sha256(canonicalize(methodBehaviourFields(descriptor)));
}
