/**
 * pointFilter.ts
 *
 * The P10 "limited shader-filter foundation" (program §P10) — pure data + policy
 * only. It generalises the existing per-point classification mask
 * (`classMaskUniform.ts`, the shared `Float32Array(256)` both backends already
 * read) into a small filter-state model, plus capability reporting and the exact
 * range-test semantics the shader will mirror.
 *
 * Scope, per §P10:
 *   • Preserve classification filtering byte-for-byte — this module does NOT
 *     touch the existing class-mask path; it only models the state around it.
 *   • Define a generalized `PointFilterState` and capability reporting.
 *   • Prove AT MOST ONE additional range filter (elevation OR intensity).
 *   • Missing attributes disable a filter cleanly (with an explicit reason for
 *     the UI); near-zero cost when disabled (callers bypass the shader branch
 *     via `isPointFilterActive`).
 *
 * The actual GPU range-filter node (a uniform + an in-range test multiplied into
 * point opacity, mirroring `classVisibleAt`) is the device-verified wiring; this
 * foundation defines the contract it must satisfy. Framework-free, unit-tested.
 */

/**
 * Generalized per-point filter state. `classificationMask` is the generalized
 * carrier for the existing class filter (mapped to the render layer's
 * `Float32Array(256)` unchanged); the two ranges are the new, optional filters.
 */
export interface PointFilterState {
  /** Bit/flag-per-class visibility (generalized form of the existing 256-entry mask). */
  readonly classificationMask?: Uint32Array;
  /** Inclusive elevation (Z) window, in the cloud's native units. */
  readonly elevationRange?: readonly [number, number];
  /** Inclusive intensity window (raw 16-bit intensity). */
  readonly intensityRange?: readonly [number, number];
}

/** Whether a filter can run, and if not, a UI-facing reason. */
export interface FilterCapability {
  readonly available: boolean;
  readonly reason?: string;
}

/** Capability of each supported filter for the current cloud. */
export interface PointFilterCapabilities {
  readonly classification: FilterCapability;
  readonly elevation: FilterCapability;
  readonly intensity: FilterCapability;
}

/** Which source attributes the active cloud actually carries. */
export interface FilterAttributeAvailability {
  readonly hasClassification: boolean;
  /** Position is the elevation source; false only when no cloud is loaded. */
  readonly hasPosition: boolean;
  readonly hasIntensity: boolean;
}

/**
 * Report which filters can run. A missing attribute disables its filter cleanly
 * with an explicit reason (so the UI can grey it out and say why) rather than a
 * silent no-op.
 */
export function pointFilterCapabilities(a: FilterAttributeAvailability): PointFilterCapabilities {
  return {
    classification: a.hasClassification
      ? { available: true }
      : { available: false, reason: 'This cloud has no per-point classification.' },
    elevation: a.hasPosition
      ? { available: true }
      : { available: false, reason: 'No cloud is loaded.' },
    intensity: a.hasIntensity
      ? { available: true }
      : { available: false, reason: 'This cloud has no per-point intensity channel.' },
  };
}

/**
 * Order-independent, finite `[min, max]`. Returns `null` when the range is
 * unusable (both bounds non-finite) — i.e. the filter is inactive. A single
 * finite bound collapses to a point range.
 */
export function normalizeRange(
  range: readonly [number, number] | undefined,
): readonly [number, number] | null {
  if (!range) return null;
  let a = range[0];
  let b = range[1];
  const aOk = Number.isFinite(a);
  const bOk = Number.isFinite(b);
  if (!aOk && !bOk) return null;
  if (!aOk) a = b;
  if (!bOk) b = a;
  return a <= b ? [a, b] : [b, a];
}

/** Is a range filter active (i.e. a usable window)? */
export function isRangeActive(range: readonly [number, number] | undefined): boolean {
  return normalizeRange(range) !== null;
}

/**
 * Inclusive in-range test — the EXACT semantics the shader mirrors. An inactive
 * range passes everything; against an active range a point with no finite value
 * FAILS (it can't be shown to satisfy the filter), matching the shader's
 * conservative discard.
 */
export function passesRange(value: number, range: readonly [number, number] | undefined): boolean {
  const r = normalizeRange(range);
  if (r === null) return true; // inactive filter → everything passes
  if (!Number.isFinite(value)) return false;
  return value >= r[0] && value <= r[1];
}

/** Count of active range filters. The P10 foundation proves AT MOST ONE. */
export function activeRangeFilterCount(state: PointFilterState): number {
  return (isRangeActive(state.elevationRange) ? 1 : 0) + (isRangeActive(state.intensityRange) ? 1 : 0);
}

/**
 * Is ANY filtering active? The "near-zero cost when disabled" gate: when this is
 * false the caller skips the filter uniform/branch entirely.
 */
export function isPointFilterActive(state: PointFilterState): boolean {
  const hasClassMask = state.classificationMask !== undefined && state.classificationMask.length > 0;
  return hasClassMask || activeRangeFilterCount(state) > 0;
}

/**
 * Enforce the foundation constraint of at most ONE range filter. If both an
 * elevation and an intensity window are set, elevation takes precedence and the
 * intensity range is dropped (documented, deterministic). Classification is
 * untouched — it is not a range filter.
 */
export function limitToSingleRangeFilter(state: PointFilterState): PointFilterState {
  if (isRangeActive(state.elevationRange) && isRangeActive(state.intensityRange)) {
    const { intensityRange: _dropped, ...rest } = state;
    return rest;
  }
  return state;
}
