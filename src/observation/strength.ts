/**
 * strength.ts — observation-strength component computation
 * (docs/observatory/SPEC.md §2.5, §5.5, OB-STR-01..02). Phase O6.
 *
 * `olv.observation.strength`. Computes the five bounded components §2.5
 * names for a `SURFACE` voxel, from the same evidence the ledger (O4) and
 * ray builder (O3) already produce — never a single hidden figure (§2.5,
 * falsification checklist §9.3's "show a composite without its weights").
 *
 * `sources` and `consistency` read straight off an `ObservationLedgerRow`'s
 * own counters (`ledger.ts`, §2.1): they need no per-ray geometry, only the
 * aggregate the ledger already accumulated. `angularSpread`, `incidence` and
 * `rangeFit` need per-hitting-ray direction and range, which the ledger's
 * counters do not retain (only counts). `accumulateStrengthHitSamples`
 * re-walks a chunk's rays with the SAME clip/DDA/hit-window primitives O4's
 * own `accumulateReturnedRay` uses (`clipRayToDomain`, `traverseVoxelSteps`,
 * `computeHitWindows`/`stepOverlapsAnyWindow`, extracted from `ledger.ts` for
 * exactly this reuse) and records one sample per hitting ray, rather than a
 * second, independently-tuned re-derivation of the hit rule.
 *
 * `incidence`'s local surface normal, the per-ray `|cos i|` and the median
 * over them live in `incidence.ts`, shared with Coverage Gain's `inc_c` term
 * (`coverageGain.ts`), so the two methods use one incidence estimate. The
 * normal is the smallest-eigenvalue eigenvector of a voxel's mean-centred
 * resident-point covariance (a closed-form solve `incidence.ts` checks
 * against `src/math/symEig3.ts` in its tests).
 *
 * Pure and DOM-free (OB-INT-01). No presentation, no run record, no
 * composite-index wiring into the panel: those are O7/O9.
 */

import { incidenceCosine, medianCosine } from './incidence';
import {
  computeHitWindows,
  stepOverlapsAnyWindow,
  traverseVoxelSteps,
  clipRayToDomain,
  packVoxelKey,
  resolveRayReturnRanges,
  type ObservationDomain,
} from './ledger';
import type { ObservationLedgerRow } from './ledger';
import type { ObservationRayChunk, ObservationReturnTable } from './rays';

// ---------------------------------------------------------------------------
// SPEC §2.5 — the five bounded components
// ---------------------------------------------------------------------------

/**
 * The five components §2.5 defines for one `SURFACE` voxel, each independently
 * bounded — never collapsed into a single hidden figure without the
 * components and their weights shown beside it.
 */
export interface ObservationStrengthComponents {
  /** Distinct sources with `hit > 0` (integer, unbounded before the saturating map). */
  readonly sources: number;
  /** `1 - ‖mean of unit ray directions of hitting rays‖`, in [0, 1]. `NaN` when there is no hitting ray. */
  readonly angularSpread: number;
  /** Median `cos i` between hitting rays and the local surface normal, in [0, 1]. `NaN` when no normal was supplied or there is no hitting ray. */
  readonly incidence: number;
  /** Fraction of hits inside the declared useful range band, in [0, 1]. `NaN` when there is no hitting ray. */
  readonly rangeFit: number;
  /** The hit fraction `f`, in [0, 1]. `NaN` when `hit + pass === 0` (no evidence to form a fraction from at all). */
  readonly consistency: number;
}

/**
 * §2.5's own worked example for the `sources` saturating map: `min(sources,
 * SOURCES_SATURATION_CAP) / SOURCES_SATURATION_CAP`.
 */
export const SOURCES_SATURATION_CAP_EXAMPLE = 3;

/** §2.5's saturating map for `sources`, using `SOURCES_SATURATION_CAP_EXAMPLE` unless a caller declares a different cap (recorded beside the composite's weights when it does, OB-STR-02). */
export function saturatedSources(sources: number, cap: number = SOURCES_SATURATION_CAP_EXAMPLE): number {
  if (!(cap > 0)) throw new Error(`saturatedSources: cap must be > 0, got ${cap}`);
  return Math.min(sources, cap) / cap;
}

// ---------------------------------------------------------------------------
// counters-only components: sources, consistency
// ---------------------------------------------------------------------------

/**
 * `sources` (SPEC §2.5): distinct sources with `hit > 0` at this voxel, read
 * straight off `row.perSource` — no per-ray geometry needed.
 */
export function countStrengthSources(row: Pick<ObservationLedgerRow, 'perSource'>): number {
  let n = 0;
  for (const s of row.perSource) if (s.hit > 0) n++;
  return n;
}

/**
 * `consistency` = `f`, the aggregate hit fraction `hit / (hit + pass)` (SPEC
 * §2.5), read straight off `row.counters`. `NaN` when `hit + pass === 0`:
 * there is no fraction to form (this voxel carries no hit/pass evidence at
 * all, e.g. it was reached only by `behind` or `noReturn`).
 */
export function computeConsistency(row: Pick<ObservationLedgerRow, 'counters'>): number {
  const n = row.counters.hit + row.counters.pass;
  return n > 0 ? row.counters.hit / n : Number.NaN;
}

// ---------------------------------------------------------------------------
// per-ray hit samples: angularSpread, incidence, rangeFit
// ---------------------------------------------------------------------------

/** One hitting ray's contribution to a voxel's strength evidence: its unit direction and the return range that landed it in this voxel's hit window. */
export interface StrengthHitSample {
  readonly sourceIndex: number;
  readonly direction: readonly [number, number, number];
  readonly range: number;
}

type Vec3 = readonly [number, number, number];

function normalizeDirection(dx: number, dy: number, dz: number): Vec3 | null {
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  return [dx / len, dy / len, dz / len];
}

/**
 * Walks one chunk's rays exactly as `ledger.ts`'s `accumulateReturnedRay`
 * does through the clip/DDA/hit-window steps, but records a
 * {@link StrengthHitSample} at every voxel step whose span overlaps ANY of
 * the ray's own return windows, instead of bumping a counter.
 *
 * `ranges` is resolved per ray by {@link resolveRayReturnRanges} — the SAME
 * per-ray CSR lookup `traverseRayChunks` uses (`returnTable`/`returnCounts`,
 * when the chunk's source declares them, otherwise the chunk's own single
 * `range[k]`) — so a voxel hit only by a ray's 2nd-or-later return (ground
 * under vegetation, say) is sampled here exactly as it is counted in the
 * ledger: `accumulateReturnedRay`'s own `hit` field fires once per voxel
 * step overlapping ANY individual return's window, never once per return,
 * and this function mirrors that ONE-sample-per-hit-step rule exactly, so a
 * voxel's strength-sample count always equals its ledger `hit` counter
 * (before saturation) — the invariant `tests/observatoryStrength.test.ts`
 * checks directly. When a step overlaps more than one return's window, the
 * sample's own `range` is the FIRST (lowest `returnIndex`) overlapping
 * return's range, matching `windows.some(...)`'s own left-to-right
 * evaluation order (deterministic, not an arbitrary pick).
 *
 * A `NaN`-range (no-return) ray contributes no sample, matching
 * `accumulateReturnedRay`'s own no-return branch never calling
 * `bumpRow('hit', ...)`.
 *
 * Returns a plain array of samples, one voxel key per entry (`Map` built by
 * the caller, or by {@link mergeStrengthHitSamples}) — no accumulation
 * happens here, so this function's own output is trivially reproducible
 * regardless of call order.
 */
export function accumulateStrengthHitSamples(
  chunk: ObservationRayChunk,
  sourceIndex: number,
  origin: Vec3,
  domain: ObservationDomain,
  voxelEdge: number,
  tauAbs: number,
  tauRel: number,
  gridNx: number,
  gridNy: number,
  returnTable?: ObservationReturnTable,
  returnCounts?: Uint16Array,
): readonly { readonly key: number; readonly sample: StrengthHitSample }[] {
  const n = chunk.originIndex.length;
  if (returnTable !== undefined && (returnCounts === undefined || returnCounts.length !== n)) {
    throw new Error('accumulateStrengthHitSamples: a chunk with a returnTable needs a matching returnCounts array (one entry per ray)');
  }

  const out: { readonly key: number; readonly sample: StrengthHitSample }[] = [];
  for (let k = 0; k < n; k++) {
    const ranges = resolveRayReturnRanges(chunk, k, returnTable, returnCounts);
    if (ranges.length === 1 && Number.isNaN(ranges[0])) continue; // no-return ray: no hit window at all.
    const direction = normalizeDirection(chunk.direction[k * 3]!, chunk.direction[k * 3 + 1]!, chunk.direction[k * 3 + 2]!);
    if (direction === null) continue;

    const clip = clipRayToDomain(origin, direction, 0, Infinity, domain);
    if (clip === null) continue;
    const steps = traverseVoxelSteps(origin, direction, clip.tEntry, clip.tExit, domain, voxelEdge);
    const windows = computeHitWindows(ranges, tauAbs, tauRel);

    for (const step of steps) {
      if (!stepOverlapsAnyWindow(step, windows)) continue;
      const overlapIndex = windows.findIndex((w) => step.tEnter < w.hi && step.tLeave > w.lo);
      const key = packVoxelKey(step.ix, step.iy, step.iz, gridNx, gridNy);
      out.push({ key, sample: { sourceIndex, direction, range: ranges[overlapIndex]! } });
    }
  }
  return out;
}

/**
 * Merges several partitions' own {@link accumulateStrengthHitSamples} output
 * into one `Map<voxelKey, StrengthHitSample[]>`, concatenating each
 * partition's samples in ASCENDING partition index (the caller's own array
 * order), never re-sorted by voxel key or anything else — OB-INV-07's "any
 * float reduction merges in a fixed order" applies here because
 * {@link computeStrengthComponents}'s own direction-sum and median reductions
 * walk this array in the order it is handed, so a fixed merge order is what
 * makes those reductions order-independent across partition counts, not
 * anything intrinsic to floating-point addition.
 */
export function mergeStrengthHitSamples(
  partials: readonly (readonly { readonly key: number; readonly sample: StrengthHitSample }[])[],
): Map<number, StrengthHitSample[]> {
  const byVoxel = new Map<number, StrengthHitSample[]>();
  for (const partial of partials) {
    for (const { key, sample } of partial) {
      let list = byVoxel.get(key);
      if (list === undefined) {
        list = [];
        byVoxel.set(key, list);
      }
      list.push(sample);
    }
  }
  return byVoxel;
}

// ---------------------------------------------------------------------------
// normal fit and incidence cosine: shared with coverage gain (incidence.ts)
// ---------------------------------------------------------------------------

/** Re-exported from `incidence.ts`, the one home of the normal fit both strength and Coverage Gain use. */
export { fitNormalFromResidentPoints } from './incidence';

// ---------------------------------------------------------------------------
// the five components, assembled
// ---------------------------------------------------------------------------

/** A declared useful range band (SPEC §2.5's "declared useful range band"; the same `minRange`/`maxRange` concept `StationAngularDomain` already declares, `observationField.ts`). Either bound omitted means unbounded on that side. */
export interface StrengthRangeBand {
  readonly minRange?: number;
  readonly maxRange?: number;
}

function withinBand(range: number, band: StrengthRangeBand): boolean {
  if (band.minRange !== undefined && range < band.minRange) return false;
  if (band.maxRange !== undefined && range > band.maxRange) return false;
  return true;
}

/**
 * Assembles the five §2.5 components for one voxel from its ledger row (for
 * `sources`/`consistency`) and its hitting-ray samples (for
 * `angularSpread`/`incidence`/`rangeFit`). `normal`, when supplied, is a
 * unit vector — from {@link fitNormalFromResidentPoints} or a source normal,
 * a caller's choice (§2.5: "or the source normals when present"); `null`
 * yields `incidence = NaN` rather than a fabricated value.
 *
 * `samples` is expected to hold every source's hitting rays at this voxel,
 * in a fixed order (the order {@link mergeStrengthHitSamples} produces) —
 * every reduction below (`angularSpread`'s direction sum, `incidence`'s
 * median) walks it once, in that order, so results are reproducible across
 * chunk order and partition count for the same underlying evidence, per
 * OB-INV-07.
 */
export function computeStrengthComponents(
  row: Pick<ObservationLedgerRow, 'perSource' | 'counters'>,
  samples: readonly StrengthHitSample[],
  normal: Vec3 | null,
  rangeBand: StrengthRangeBand,
): ObservationStrengthComponents {
  const sources = countStrengthSources(row);
  const consistency = computeConsistency(row);

  if (samples.length === 0) {
    return { sources, angularSpread: Number.NaN, incidence: Number.NaN, rangeFit: Number.NaN, consistency };
  }

  let sx = 0, sy = 0, sz = 0;
  let inBand = 0;
  const cosines: number[] = [];
  for (const s of samples) {
    sx += s.direction[0];
    sy += s.direction[1];
    sz += s.direction[2];
    if (withinBand(s.range, rangeBand)) inBand++;
    if (normal !== null) {
      cosines.push(incidenceCosine(s.direction, normal));
    }
  }
  const n = samples.length;
  const meanNorm = Math.hypot(sx / n, sy / n, sz / n);
  const angularSpread = Math.min(1, Math.max(0, 1 - meanNorm));
  const rangeFit = inBand / n;
  const incidence = normal === null ? Number.NaN : medianCosine(cosines);

  return { sources, angularSpread, incidence, rangeFit, consistency };
}

// ---------------------------------------------------------------------------
// SPEC §5.5 OB-STR-02 — the composite index, shown only with its weights
// ---------------------------------------------------------------------------

/** OB-STR-02's declared weights, one per bounded input to the composite (the four [0,1] components plus saturated `sources`). */
export interface StrengthCompositeWeights {
  readonly sources: number;
  readonly angularSpread: number;
  readonly incidence: number;
  readonly rangeFit: number;
  readonly consistency: number;
}

export interface StrengthComposite {
  readonly index: number;
  readonly weights: StrengthCompositeWeights;
  readonly components: ObservationStrengthComponents;
  readonly sourcesSaturationCap: number;
}

/**
 * The composite index (§2.5): "the declared weighted mean of the bounded
 * components", with `sources` entering through {@link saturatedSources}.
 * Always returned bundled with its weights and the raw components (OB-STR-02;
 * falsification checklist §9.3: "show a composite without its weights").
 * A component that is `NaN` (no evidence to form it) is excluded from BOTH
 * the weighted sum and the weight total, so the mean stays a mean over the
 * components actually available, rather than silently treating a missing
 * component as zero.
 */
export function computeStrengthComposite(
  components: ObservationStrengthComponents,
  weights: StrengthCompositeWeights,
  sourcesSaturationCap: number = SOURCES_SATURATION_CAP_EXAMPLE,
): StrengthComposite {
  const bounded: { readonly value: number; readonly weight: number }[] = [
    { value: saturatedSources(components.sources, sourcesSaturationCap), weight: weights.sources },
    { value: components.angularSpread, weight: weights.angularSpread },
    { value: components.incidence, weight: weights.incidence },
    { value: components.rangeFit, weight: weights.rangeFit },
    { value: components.consistency, weight: weights.consistency },
  ];
  let weightedSum = 0;
  let weightTotal = 0;
  for (const { value, weight } of bounded) {
    if (Number.isNaN(value)) continue;
    weightedSum += value * weight;
    weightTotal += weight;
  }
  const index = weightTotal > 0 ? weightedSum / weightTotal : Number.NaN;
  return { index, weights, components, sourcesSaturationCap };
}
