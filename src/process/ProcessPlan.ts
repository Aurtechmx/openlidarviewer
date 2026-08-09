/**
 * ProcessPlan.ts — the pure capability model for Process Studio (v0.6.5).
 *
 * A ProcessPlan answers one question a user actually has: "what can I safely
 * produce from this data?" It is a plain-data description — no DOM, no I/O, no
 * three.js — so the UI, the exporters, and the tests all read the SAME
 * eligibility verdicts. The rule this enforces is that eligibility lives in one
 * place ({@link evaluateCapabilities}), never re-derived inside a button.
 *
 * Every product is `ready`, `review`, or `blocked` with an explicit,
 * greppable reason code. The vocabulary deliberately fails closed: when a fact
 * needed for a metric product is unknown (an unconfirmed linear unit, a
 * differing vertical reference, resident-only streaming coverage), the product
 * is withheld or flagged, never silently produced. This mirrors the honesty
 * contract the terrain and export surfaces already hold in v0.6.4.
 *
 * Phase 1 defines the model and a first set of rules. Later phases add products
 * (semantic classes, registration, features) by extending the enum and the
 * evaluator, not by adding parallel eligibility logic elsewhere.
 */

import type { CrsInfo } from '../io/crs';

/** How ready a derivable product is, given the loaded data. */
export type Readiness = 'ready' | 'review' | 'blocked';

/** How much of a scan the operation can actually see. */
export type Coverage = 'full' | 'sampled' | 'resident-only';

/** Whether a scan carries classification, and how completely. */
export type ClassPresence = 'none' | 'partial' | 'full';

/**
 * Where a scan's classification came from. This is an EPISTEMIC fact, not just a
 * presence flag: a class-2 point the producer surveyed is trusted ground; a
 * class-2 point OLV derived from geometry is a heuristic estimate; a manually
 * edited class carries the editor's judgement. The capability model treats them
 * differently — only producer classes back a `ready` verdict; derived, manual
 * or unknown provenance can at most reach `review`.
 */
export type ClassificationProvenance = 'producer' | 'derived' | 'manual' | 'unknown' | 'none';

/** The products the capability model reasons about in Phase 1. */
export type ProductId =
  | 'classify-gaps'
  | 'dtm'
  | 'dsm'
  | 'contours'
  | 'building-footprints'
  | 'cross-epoch-change'
  | 'volume-cut-fill';

/**
 * A plain-data snapshot of ONE loaded scan — the facts the evaluator needs.
 * Assembled by the shell from existing scan-report / streaming signals; kept
 * free of live objects so the evaluator stays pure and worker-safe.
 */
export interface ScanFacts {
  /** Static (whole file resident) or streaming (COPC/EPT). */
  readonly kind: 'static' | 'streaming';
  /** How much of the scan the operation can read — drives coverage honesty. */
  readonly coverage: Coverage;
  /** Detected CRS, or null when none is recoverable. */
  readonly crs: CrsInfo | null;
  /** Total points in the source (not the resident count). */
  readonly pointCount: number;
  readonly hasRgb: boolean;
  readonly hasIntensity: boolean;
  readonly hasGpsTime: boolean;
  readonly hasReturnNumber: boolean;
  readonly hasPointSourceId: boolean;
  /** Classification presence, from the producer or a prior derive. */
  readonly classification: ClassPresence;
  /** Where the classification came from — gates trusted vs derived verdicts.
   *  Always set by `deriveScanFacts`; optional so hand-built facts need not. */
  readonly classificationProvenance?: ClassificationProvenance;
  /** True when TRUSTED (producer) class 2 (ground) is present. Derived or
   *  manually edited ground does not set this — it can only reach `review`. */
  readonly groundClassified: boolean;
  /** True when TRUSTED (producer) class 6 (building) points are present. */
  readonly hasBuildingClass: boolean;
  /** Median point spacing in metres, when measurable. */
  readonly medianSpacing?: number;
}

/** Everything the evaluator reasons over: the loaded scans and their relation. */
export interface ProcessInputs {
  readonly scans: readonly ScanFacts[];
  /**
   * For a two-scan comparison: whether the two share a proven-compatible
   * spatial frame. `undefined` means not yet determined (→ review, not ready).
   */
  readonly projectFrameCompatible?: boolean;
}

/** One product's verdict, with a stable reason code and a human sentence. */
export interface ProductCapability {
  readonly product: ProductId;
  readonly readiness: Readiness;
  /** Stable UPPER_SNAKE slug — greppable, safe to switch on. */
  readonly reasonCode: string;
  /** One human sentence explaining the verdict. */
  readonly reason: string;
}

/** The capability model for the current dataset(s). */
export interface ProcessPlan {
  readonly products: readonly ProductCapability[];
}
