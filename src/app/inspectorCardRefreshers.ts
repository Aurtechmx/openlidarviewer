
// Inspector load-time card refreshers — extracted from main.ts.
//
// These functions push freshly-derived facts into the Inspector's
// Provenance and Dataset Intelligence cards at scan-open time, from data
// already in hand (header / source kind). They iterate no points and run no
// engine analysis; the engine-only rows stay "—" until terrain analysis runs
// (whose finished result the two `note*` folders merge back in afterwards).
//
// Each refresher depends only on the `Inspector` instance plus the pure
// provenance/dataset-intelligence helpers, so they extract cleanly behind a
// thin factory that captures the inspector once. Call sites destructure the
// returned object and otherwise behave exactly as before.
import type { Inspector } from '../ui/Inspector';
import { isLinearUnitKnown } from '../geo/CoordinateTypes';
import { captureProvenance } from '../diagnostics/captureProvenance';
import {
  signalsForStaticCloud,
  signalsForStreamingCloud,
} from '../diagnostics/provenanceSignals';
import {
  TERRAIN_METRIC_VERSION,
  type DerivedComplexity,
  type IntelCoverageMeta,
} from '../terrain/datasetIntelligence';
import type { TerrainCoverageMode } from '../terrain/TerrainContracts';

/** The slice of a finished terrain run the Dataset Intelligence card reads. */
export interface TerrainRunCardFacts {
  readonly dtm: {
    readonly analyzedPointCount: number;
    readonly coverageMode: TerrainCoverageMode;
  };
  readonly quality: {
    /** Mean per-cell confidence, 0..100. */
    readonly meanCellConfidence: number;
    /** Ground returns / all returns, 0..1 (NaN when unknown). */
    readonly groundPointRatio: number;
  };
}
import type { StreamingSourceKind } from '../render/streaming/StreamingSource';

export interface InspectorCardRefreshers {
  /**
   * Record a freshly attached static cloud as the scan the provenance store
   * describes, owned by the layer id it was added under. The id is what lets a
   * scene-scoped surface tell whether the stored verdict belongs to the layer
   * it is describing, since static layers are additive and only the newest open
   * becomes the active scan.
   */
  refreshProvenance(
    cloud: {
      readonly sourceFormat: string;
      readonly pointCount: number;
    },
    layerId: string,
  ): void;
  /** Record a freshly attached streaming cloud as the scan the provenance store describes. */
  refreshProvenanceFromStreaming(cloud: {
    readonly kind: StreamingSourceKind;
    // `null` where the format states no total, which leaves density unset.
    readonly sourcePointCount?: number | null;
  }): void;
  /** Push a cheap Dataset Intelligence summary from a static cloud's header. */
  refreshDatasetIntelligenceFromStaticCloud(cloud: {
    readonly pointCount: number;
    readonly declaredPointCount?: number;
    readonly metadata?: { crs?: { linearUnit?: string; linearUnitToMetres?: number; verticalUnitToMetres?: number } | null };
    bounds(): { min: [number, number, number]; max: [number, number, number] };
  }): void;
  /** Push a cheap Dataset Intelligence summary from a streaming cloud's header. */
  refreshDatasetIntelligenceFromStreamingCloud(cloud: {
    readonly sourcePointCount?: number;
    readonly metadata?: {
      readonly header?: {
        readonly min?: readonly [number, number, number] | number[];
        readonly max?: readonly [number, number, number] | number[];
      };
    };
    crs?(): { linearUnit?: string; linearUnitToMetres?: number; verticalUnitToMetres?: number } | null;
  }): void;
  /**
   * Fold a real analysed-point count from a finished terrain run into the
   * card, static or streaming. The streaming attach-time summary writes
   * `analyzedPointCount: 0` and the static one the resident sample size;
   * either way the Details row reads the run's walked count afterwards.
   */
  noteAnalyzedPointCount(count: number): void;
  /**
   * Fold a finished terrain run's measured facts into the card: the walked
   * point count, the engine coverage mode, the mean cell confidence (Metric
   * Stability) and the ground-return share (Ground Visibility), and mark the
   * engine active. Non-finite values are skipped so a row never shows a
   * number the run did not measure.
   */
  noteTerrainRun(run: TerrainRunCardFacts): void;
  /**
   * Fold a finished terrain run's ENGINE-DERIVED complexity (the VRM/TPI
   * summary — band + the numeric detail with window and units) into the last
   * pushed Dataset Intelligence summary, replacing the header-time heuristic.
   * `null` no-ops (a run that measured nothing leaves the row as it was).
   * Works for both static and streaming scans; the terrain runner's
   * stale-result guard means this never fires for a closed/replaced scan,
   * and a new scan's attach-time refresh (which carries no derived
   * complexity) naturally resets the row.
   */
  noteTerrainComplexity(derived: DerivedComplexity | null): void;
}

/** The CRS fields the unit conversions below read. */
type UnitCrs =
  | { readonly linearUnit?: string; readonly linearUnitToMetres?: number; readonly verticalUnitToMetres?: number }
  | null
  | undefined;

/**
 * The bbox spans `[x, y, z]` in METRES, or `undefined` under the same
 * fail-closed unit gate as {@link metresCubedBbox}. The spans carry the SHAPE
 * the volume alone loses: a wide, thin airborne swath and a compact tower can
 * share a volume, and only the former should be tiered on points per m².
 * A zero vertical span is kept (a perfectly flat sheet is still a valid
 * footprint); a zero horizontal span is not, since it has no area.
 */
function metresBboxSpans(
  dx: number,
  dy: number,
  dz: number,
  crs: UnitCrs,
): [number, number, number] | undefined {
  if (!isLinearUnitKnown(crs)) return undefined;
  const mpu = crs?.linearUnitToMetres;
  if (!Number.isFinite(mpu) || (mpu as number) <= 0) return undefined;
  const vmpuRaw = crs?.verticalUnitToMetres ?? mpu;
  if (!Number.isFinite(vmpuRaw) || (vmpuRaw as number) <= 0) return undefined;
  const sx = dx * (mpu as number);
  const sy = dy * (mpu as number);
  const sz = dz * (vmpuRaw as number);
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) return undefined;
  if (sx <= 0 || sy <= 0 || sz < 0) return undefined;
  return [sx, sy, sz];
}

/**
 * The bounding-box volume in cubic METRES, or `undefined` when the CRS declares
 * no usable linear unit. FAIL CLOSED: an unknown-unit CRS carries the inert
 * placeholder `linearUnitToMetres: 1`, so converting with it would feed raw
 * source-unit³ (feet³, degrees³) into the per-m³ density bucketing and mis-tier
 * the scan — `classifyDensity` renders "—" for an absent volume, which is the
 * honest state. Two axes are horizontal (×linear), one vertical (×vertical); the
 * scalar factor mpu²·vmpu is order-independent. Shared by the static and
 * streaming refreshers so the two paths can never diverge (see
 * `tests/benchmark/unitIntegrity.test.ts`).
 */
function metresCubedBbox(
  dx: number,
  dy: number,
  dz: number,
  crs: UnitCrs,
): number | undefined {
  const spans = metresBboxSpans(dx, dy, dz, crs);
  if (!spans) return undefined;
  const v = spans[0] * spans[1] * spans[2];
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Build the Inspector card refreshers bound to a single `Inspector`.
 * The behaviour of each returned function is identical to the original
 * top-level functions in main.ts — only the `inspector` binding moved here.
 */
export function createInspectorCardRefreshers(
  inspector: Inspector,
  /**
   * The RESOLVED active CRS unit frame (`crsService.context()`), so the Dataset
   * Intelligence density tier honours a user CRS/unit override instead of the
   * file's declared `metadata.crs` / streaming `crs()`. Omitted by the pure
   * factory tests, which fall back to the cloud's declared CRS — byte-identical
   * for a same-unit no-override scan, and fail-closed for an unknown unit either
   * way.
   */
  resolvedCrs?: () =>
    | { readonly linearUnit?: string; readonly linearUnitToMetres?: number; readonly verticalUnitToMetres?: number }
    | null,
): InspectorCardRefreshers {
  // The last summary pushed by the STREAMING refresher. Nulled by the static
  // refresher so a streamed-scan summary can never be merged onto a later
  // static scan; the terrain runner's stale-result guard already prevents a
  // result for a closed scan from reaching the note* folds at all.
  let lastStreamingSummary: Parameters<Inspector['setDatasetIntelligence']>[0] | null = null;
  // The last summary pushed by EITHER path (static or streaming), so a
  // finished terrain run can fold its engine-derived complexity into it
  // (`noteTerrainComplexity`) without re-deriving the header facts. Reset by
  // every attach-time refresh, so derived numbers never survive a scan swap.
  let lastSummary: Parameters<Inspector['setDatasetIntelligence']>[0] | null = null;

  // The panel renders whatever the shared store says, including a verdict that
  // arrives after the refresher below already ran: the shape router only decides
  // in `revealAnalysePanel`, which both open paths call after their provenance
  // refresh, and a streaming re-route or a manual "Treat as" pick moves it again
  // later in the session. Pushing from here keeps the card in step with the
  // report PDF and the exported images, which read the same store.
  captureProvenance.onChange((f) => {
    if (f) inspector.setProvenance(f);
    else inspector.clearProvenance();
  });

  /**
   * The capture signals' unit authority, or `undefined` when this factory was
   * built without a resolved frame.
   *
   * `undefined` is NOT a metric claim — the signal builder then reads the
   * cloud's declared CRS and still fails closed when that states no unit. It
   * exists because the pure factory tests construct refreshers with no CRS
   * service, which is the contract documented on `resolvedCrs` above. Production
   * always supplies one, so production is always authoritative.
   */
  function captureUnitAuthority(): { readonly metresPerUnit: number | null } | undefined {
    if (!resolvedCrs) return undefined;
    const c = resolvedCrs();
    if (!c || c.linearUnit === 'unknown') return { metresPerUnit: null };
    const f = c.linearUnitToMetres;
    return { metresPerUnit: typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : null };
  }

  function refreshProvenance(
    cloud: {
      readonly sourceFormat: string;
      readonly pointCount: number;
    },
    layerId: string,
  ): void {
    // The RESOLVED frame decides whether metric signals may exist at all.
    captureProvenance.setScan({
      layerId,
      signals: signalsForStaticCloud(cloud as never, captureUnitAuthority()),
    });
  }

  function refreshProvenanceFromStreaming(cloud: {
    readonly kind: StreamingSourceKind;
    // `null` where the format states no total, which leaves the density signal
    // unset rather than deriving one from an invented number.
    readonly sourcePointCount?: number | null;
  }): void {
    // A streaming open closes the static layers, so the streaming source is the
    // whole scene and carries no static layer id.
    captureProvenance.setScan({
      layerId: null,
      signals: signalsForStreamingCloud(cloud as never, captureUnitAuthority()),
    });
  }

  /**
   * Push a cheap Dataset Intelligence summary into the Inspector's
   * card from data already in hand at load time. This populates the
   * Point Density row from declared `pointCount / bbox volume` and the
   * Streaming Coverage row from the source kind. No point iteration,
   * no engine analysis — just stable header-derived facts the user
   * can see immediately. The Dataset Intelligence card stays
   * header-derived for now.
   */
  function refreshDatasetIntelligenceFromStaticCloud(cloud: {
    readonly pointCount: number;
    readonly declaredPointCount?: number;
    readonly metadata?: { crs?: { linearUnit?: string; linearUnitToMetres?: number; verticalUnitToMetres?: number } | null };
    bounds(): { min: [number, number, number]; max: [number, number, number] };
  }): void {
    // A static summary supersedes any remembered streaming one.
    lastStreamingSummary = null;
    try {
      const b = cloud.bounds();
      const dx = b.max[0] - b.min[0];
      const dy = b.max[1] - b.min[1];
      const dz = b.max[2] - b.min[2];
      // Convert the bbox to cubic METRES before the per-m³ density bucketing —
      // a state-plane-FEET tile is otherwise ~35× under-dense and a genuine QL1
      // survey grades "sparse". Two axes are horizontal (×linear), one vertical
      // (×vertical); the scalar factor mpu²·vmpu is order-independent.
      //
      // FAIL CLOSED on the unit: a cubic-metre volume is only computed when the
      // CRS declares a REAL linear unit. An unknown-unit CRS carries the inert
      // placeholder factor 1, so multiplying by it would feed raw source-unit³
      // (feet³, degrees³) into the per-m³ bucketing and mis-tier the density.
      // When the unit is unconfirmed, both the volume and the spans are left
      // undefined and the density row renders "—" rather than a wrong tier.
      const crsForUnits = resolvedCrs ? resolvedCrs() : cloud.metadata?.crs;
      const bboxSpansM = metresBboxSpans(dx, dy, dz, crsForUnits);
      const bboxVolume = metresCubedBbox(dx, dy, dz, crsForUnits);
      // Density numerator is the file's declared total, back-scaled when the
      // loader strided for display — matching the Scan Report, not the smaller
      // in-memory sample that would under-report the tier.
      const declared = cloud.declaredPointCount;
      const n = declared !== undefined && declared > cloud.pointCount ? declared : cloud.pointCount;
      const summary: Parameters<Inspector['setDatasetIntelligence']>[0] = {
        pointCount: n,
        bboxVolume,
        // The spans let the summariser tier a flat airborne tile on points per
        // footprint m². Per-m³ alone reads a wide thin swath as "Sparse" even
        // when its pts/m² is a comfortable QL1, because most of the bounding
        // box is empty air between the ground and the flight line.
        bboxSpansM,
        coverageMeta: {
          // A loader stride leaves only a display sample resident: the extent
          // is complete, the point set is not, so the row must not say "Full".
          coverage: cloud.pointCount < n ? 'display-sample' : 'full',
          sourcePointCount: n,
          // What is actually resident (and what a run can walk) — the declared
          // header total stays on `sourcePointCount`.
          analyzedPointCount: cloud.pointCount,
          // v0.3.10 honesty pass — this path runs at load time from
          // header data ALONE. No terrain analysis has happened yet, so
          // we have nothing meaningful to say about confidence. The
          // prior code pushed a hardcoded `60` here, which rendered as
          // a green/yellow chip and implied the engine had measured
          // stability. Leaving the field unset lets the summariser
          // emit `band: 'unknown'` + `label: '—'`, matching the
          // "engine-only signals stay '—' until the engine runs"
          // contract the README documents for the other rows.
          warnings: [],
        },
        metricVersion: TERRAIN_METRIC_VERSION,
      };
      lastSummary = summary;
      inspector.setDatasetIntelligence(summary);
    } catch {
      // A cheap summary failure must never block load completion.
      lastSummary = null;
      inspector.clearDatasetIntelligence();
    }
  }

  function refreshDatasetIntelligenceFromStreamingCloud(cloud: {
    readonly sourcePointCount?: number;
    readonly metadata?: {
      readonly header?: {
        readonly min?: readonly [number, number, number] | number[];
        readonly max?: readonly [number, number, number] | number[];
      };
    };
    crs?(): { linearUnit?: string; linearUnitToMetres?: number; verticalUnitToMetres?: number } | null;
  }): void {
    try {
      const sourcePoints = cloud.sourcePointCount;
      const hMin = cloud.metadata?.header?.min;
      const hMax = cloud.metadata?.header?.max;
      let bboxVolume: number | undefined;
      let bboxSpansM: [number, number, number] | undefined;
      if (hMin && hMax && hMin.length >= 3 && hMax.length >= 3) {
        const dx = hMax[0] - hMin[0];
        const dy = hMax[1] - hMin[1];
        const dz = hMax[2] - hMin[2];
        // Cubic METRES, for the same reason the static path above converts: a
        // state-plane-feet tile's header box is 35.31x larger in raw units, so
        // the per-m³ bucketing dropped a genuine QL1 survey a whole tier. The
        // header carries source units; the CRS carries the factors. FAIL CLOSED
        // on the unit exactly as the static path does — an unknown-unit CRS
        // leaves the volume and the spans undefined rather than feeding raw
        // feet³ / degrees³ into the bucketing.
        const crsForUnits = resolvedCrs ? resolvedCrs() : (cloud.crs?.() ?? null);
        bboxSpansM = metresBboxSpans(dx, dy, dz, crsForUnits);
        bboxVolume = metresCubedBbox(dx, dy, dz, crsForUnits);
      }
      const summary = {
        pointCount: sourcePoints,
        bboxVolume,
        // Same reason as the static path: a flat swath is tiered on pts/m².
        bboxSpansM,
        coverageMeta: {
          coverage: 'resident-only' as const,
          sourcePointCount: sourcePoints ?? 0,
          // Nothing has been analysed at attach time. `noteAnalyzedPointCount`
          // replaces this with the real walked-point count once a terrain run
          // finishes; until then the Details row honestly reads "0".
          analyzedPointCount: 0,
          // v0.3.10 honesty pass — see the static path for the full
          // reasoning. No engine measurement → no confidence number.
          // Leaving the field unset surfaces "—" instead of the prior
          // hardcoded `50` which read as a yellow chip and implied a
          // streaming-specific stability measurement.
          warnings: [],
        },
        metricVersion: TERRAIN_METRIC_VERSION,
      };
      lastStreamingSummary = summary;
      lastSummary = summary;
      inspector.setDatasetIntelligence(summary);
    } catch {
      lastStreamingSummary = null;
      lastSummary = null;
      inspector.clearDatasetIntelligence();
    }
  }

  /** Merge run-fed fields onto the CURRENT summary (static or streaming). */
  function foldCoverageMeta(
    patch: Partial<IntelCoverageMeta>,
    extra: { groundPointRatio?: number; engineRan?: boolean } = {},
  ): void {
    const base = lastSummary;
    if (!base?.coverageMeta) return;
    const updated = { ...base, ...extra, coverageMeta: { ...base.coverageMeta, ...patch } };
    lastSummary = updated;
    if (lastStreamingSummary) lastStreamingSummary = updated;
    inspector.setDatasetIntelligence(updated);
  }

  function noteAnalyzedPointCount(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    foldCoverageMeta({ analyzedPointCount: Math.round(count) });
  }

  function noteTerrainRun(run: TerrainRunCardFacts): void {
    const base = lastSummary?.coverageMeta;
    if (!base) return;
    const count = run.dtm.analyzedPointCount;
    const mode = run.dtm.coverageMode;
    const confidence = run.quality.meanCellConfidence;
    const ground = run.quality.groundPointRatio;
    foldCoverageMeta(
      {
        ...(Number.isFinite(count) && count > 0 ? { analyzedPointCount: Math.round(count) } : {}),
        // The engine's 'full' means "every RESIDENT point walked"; a strided
        // display sample stays labelled as one. Any partial mode wins as-is.
        coverage: mode === 'full' && base.coverage === 'display-sample' ? base.coverage : mode,
        ...(Number.isFinite(confidence) ? { confidence } : {}),
      },
      { engineRan: true, ...(Number.isFinite(ground) ? { groundPointRatio: ground } : {}) },
    );
  }

  function noteTerrainComplexity(derived: DerivedComplexity | null): void {
    const base = lastSummary;
    if (!base || !derived) return;
    const updated = { ...base, complexityDerived: derived };
    lastSummary = updated;
    if (lastStreamingSummary) lastStreamingSummary = updated;
    inspector.setDatasetIntelligence(updated);
  }

  return {
    refreshProvenance,
    refreshProvenanceFromStreaming,
    refreshDatasetIntelligenceFromStaticCloud,
    refreshDatasetIntelligenceFromStreamingCloud,
    noteAnalyzedPointCount,
    noteTerrainRun,
    noteTerrainComplexity,
  };
}
