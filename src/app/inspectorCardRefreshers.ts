// Inspector load-time card refreshers — extracted from main.ts.
//
// These four functions push freshly-derived facts into the Inspector's
// Provenance and Dataset Intelligence cards at scan-open time, from data
// already in hand (header / source kind). They iterate no points and run no
// engine analysis; the engine-only rows stay "—" until terrain analysis runs.
//
// Each refresher depends only on the `Inspector` instance plus the pure
// provenance/dataset-intelligence helpers, so they extract cleanly behind a
// thin factory that captures the inspector once. Call sites destructure the
// returned object and otherwise behave exactly as before.
import type { Inspector } from '../ui/Inspector';
import { classify as classifyProvenance } from '../diagnostics/provenance';
import {
  signalsForStaticCloud,
  signalsForStreamingCloud,
} from '../diagnostics/provenanceSignals';
import { TERRAIN_METRIC_VERSION } from '../terrain/datasetIntelligence';

export interface InspectorCardRefreshers {
  /** Refresh the Inspector's provenance panel from a freshly attached static cloud. */
  refreshProvenance(cloud: {
    readonly sourceFormat: string;
    readonly pointCount: number;
  }): void;
  /** Refresh the Inspector's provenance panel from a freshly attached streaming cloud. */
  refreshProvenanceFromStreaming(cloud: {
    readonly kind: 'copc' | 'ept';
    readonly sourcePointCount?: number;
  }): void;
  /** Push a cheap Dataset Intelligence summary from a static cloud's header. */
  refreshDatasetIntelligenceFromStaticCloud(cloud: {
    readonly pointCount: number;
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
  }): void;
  /**
   * Fold a real analysed-point count from a finished terrain run into the
   * card. Only acts when the last summary came from the STREAMING path, whose
   * attach-time summary necessarily wrote `analyzedPointCount: 0` ("no
   * analysis yet") — without this, the Details panel keeps reading
   * "Analyzed Points 0" forever on streamed scans, even after a run walked
   * hundreds of thousands of points. The static path already carries a count
   * and is left untouched.
   */
  noteAnalyzedPointCount(count: number): void;
}

/**
 * Build the Inspector card refreshers bound to a single `Inspector`.
 * The behaviour of each returned function is identical to the original
 * top-level functions in main.ts — only the `inspector` binding moved here.
 */
export function createInspectorCardRefreshers(
  inspector: Inspector,
): InspectorCardRefreshers {
  // The last summary pushed by the STREAMING refresher, remembered so a
  // finished terrain run can re-push it with the real analysed-point count
  // (see `noteAnalyzedPointCount`). Nulled by the static refresher so a
  // streamed-scan summary can never be merged onto a later static scan; the
  // terrain runner's stale-result guard already prevents a result for a
  // closed scan from reaching `noteAnalyzedPointCount` at all.
  let lastStreamingSummary: Parameters<Inspector['setDatasetIntelligence']>[0] | null = null;

  function refreshProvenance(cloud: {
    readonly sourceFormat: string;
    readonly pointCount: number;
  }): void {
    const signals = signalsForStaticCloud(cloud as never);
    const f = classifyProvenance(signals);
    inspector.setProvenance(f);
  }

  function refreshProvenanceFromStreaming(cloud: {
    readonly kind: 'copc' | 'ept';
    readonly sourcePointCount?: number;
  }): void {
    const signals = signalsForStreamingCloud(cloud as never);
    const f = classifyProvenance(signals);
    inspector.setProvenance(f);
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
    bounds(): { min: [number, number, number]; max: [number, number, number] };
  }): void {
    // A static summary supersedes any remembered streaming one.
    lastStreamingSummary = null;
    try {
      const b = cloud.bounds();
      const dx = b.max[0] - b.min[0];
      const dy = b.max[1] - b.min[1];
      const dz = b.max[2] - b.min[2];
      const bboxVolume = dx * dy * dz;
      inspector.setDatasetIntelligence({
        pointCount: cloud.pointCount,
        bboxVolume: Number.isFinite(bboxVolume) && bboxVolume > 0 ? bboxVolume : undefined,
        coverageMeta: {
          coverage: 'full',
          sourcePointCount: cloud.pointCount,
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
      });
    } catch {
      // A cheap summary failure must never block load completion.
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
  }): void {
    try {
      const sourcePoints = cloud.sourcePointCount;
      const hMin = cloud.metadata?.header?.min;
      const hMax = cloud.metadata?.header?.max;
      let bboxVolume: number | undefined;
      if (hMin && hMax && hMin.length >= 3 && hMax.length >= 3) {
        const dx = hMax[0] - hMin[0];
        const dy = hMax[1] - hMin[1];
        const dz = hMax[2] - hMin[2];
        const v = dx * dy * dz;
        if (Number.isFinite(v) && v > 0) bboxVolume = v;
      }
      const summary = {
        pointCount: sourcePoints,
        bboxVolume,
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
      inspector.setDatasetIntelligence(summary);
    } catch {
      lastStreamingSummary = null;
      inspector.clearDatasetIntelligence();
    }
  }

  function noteAnalyzedPointCount(count: number): void {
    const base = lastStreamingSummary;
    if (!base || !Number.isFinite(count) || count <= 0) return;
    const updated = {
      ...base,
      coverageMeta: {
        ...base.coverageMeta!,
        analyzedPointCount: Math.round(count),
      },
    };
    lastStreamingSummary = updated;
    inspector.setDatasetIntelligence(updated);
  }

  return {
    refreshProvenance,
    refreshProvenanceFromStreaming,
    refreshDatasetIntelligenceFromStaticCloud,
    refreshDatasetIntelligenceFromStreamingCloud,
    noteAnalyzedPointCount,
  };
}
