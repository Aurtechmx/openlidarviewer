/**
 * stateProviders.ts — one provider per scientific state strip item (CE-STRIP-02).
 *
 * A provider is a pure function of canonical state that returns
 * `{ value, source, validity }` (CE-SCOPE-05): the display value, where it came
 * from, and a state from the existing state grammar (`SciState`). A provider
 * selects and translates; it never computes a scientific value of its own and
 * never mutates its input. Each input is the object the app already owns:
 *
 *   • dataset name      ← the streaming source's name, else the active static
 *                          cloud's (`ScanService.activeCloud()`), with the same
 *                          precedence `signalsFromLive` applies (a mounted
 *                          streaming source is the active scan)
 *   • horizontal CRS    ← `CrsService.context()` (a `SpatialContext`) and
 *                          `CrsService.current()` for the resolution source
 *   • vertical reference← the same `SpatialContext`
 *   • layer basis       ← `ScanFacts.coverage`, as `deriveScanFacts` settles it
 *                          from `signalsFromLive`
 *   • review and blocked← the Analyse home's `analysisRows` statuses and the
 *                          results index's `stale` entries
 *
 * Processing has no provider here: no single owner holds the running task and
 * its progress (see docs/ux/NAVIGATION_MAP.md §7).
 */

import type { SpatialContext } from '../geo/SpatialContext';
import type { CrsSource, ResolvedCrs } from '../geo/CoordinateTypes';
import type { CrsValiditySeverity } from '../geo/CrsValidation';
import { heightLabel } from '../geo/height';
import type { Coverage, ScanFacts } from './ProcessPlan';
import type { AnalysisRow } from './analysisStatus';
import type { ResultEntry } from '../app/results/resultsIndex';
import type { SciState } from '../ui/stateChip';

/** What every strip provider returns. */
export interface StripFact<V = string> {
  /** The display value, exactly as the owner states it. */
  readonly value: V;
  /** Where the value came from: the owner, and the owner's own source token. */
  readonly source: string;
  /** The value's state in the existing state grammar. */
  readonly validity: SciState;
}

// ── Dataset name ─────────────────────────────────────────────────────────────

export interface DatasetNameInput {
  /** `viewer.streamingCloud?.name`, or null when no streaming source is mounted. */
  readonly streamingName: string | null | undefined;
  /** `ScanService.activeCloud()?.name`, or null when no static cloud is active. */
  readonly activeCloudName: string | null | undefined;
}

/** The active scan's name, or null when no scan is open. */
export function datasetNameProvider(input: DatasetNameInput): StripFact | null {
  if (input.streamingName != null) {
    return { value: input.streamingName, source: 'streaming-source', validity: 'info' };
  }
  if (input.activeCloudName != null) {
    return { value: input.activeCloudName, source: 'active-cloud', validity: 'info' };
  }
  return null;
}

// ── Horizontal CRS and unit ─────────────────────────────────────────────────

/** The metric ladder's UI severity, in the state grammar. */
const SEVERITY_STATE: Readonly<Record<CrsValiditySeverity, SciState>> = {
  ok: 'measured',
  caution: 'review',
  warn: 'review',
  block: 'blocked',
};

export interface HorizontalCrs {
  readonly crsName: string;
  readonly epsg: number | undefined;
  readonly linearUnit: SpatialContext['linearUnit'];
  readonly linearUnitKnown: boolean;
}

/**
 * The horizontal CRS and linear unit from the spatial context. `source` is the
 * resolved CRS's own source token (`las-evlr`, `user-override`, ...), or
 * `unresolved` when no CRS has been resolved.
 */
export function horizontalCrsProvider(
  context: SpatialContext,
  resolved: ResolvedCrs | null,
): StripFact<HorizontalCrs> {
  const source: CrsSource | 'unresolved' = resolved?.source ?? 'unresolved';
  return {
    value: {
      crsName: context.crsName,
      epsg: context.epsg,
      linearUnit: context.linearUnit,
      linearUnitKnown: context.linearUnitKnown,
    },
    source,
    validity: SEVERITY_STATE[context.metricSeverity],
  };
}

// ── Vertical reference ──────────────────────────────────────────────────────

export interface VerticalRef {
  /** `heightLabel` of the reference, or `Vertical: unknown`. */
  readonly label: string;
  readonly reference: SpatialContext['verticalReference'];
  readonly datum: string | undefined;
  readonly epsg: number | undefined;
}

export const VERTICAL_UNKNOWN = 'Vertical: unknown';

/** The vertical reference from the spatial context. */
export function verticalReferenceProvider(context: SpatialContext): StripFact<VerticalRef> {
  const known = context.verticalReferenceKnown;
  return {
    value: {
      label: known ? heightLabel(context.verticalReference) : VERTICAL_UNKNOWN,
      reference: context.verticalReference,
      datum: context.verticalDatum,
      epsg: context.verticalEpsg,
    },
    source: 'spatial-context',
    validity: known ? 'measured' : 'review',
  };
}

// ── Basis of the active layer ───────────────────────────────────────────────

const COVERAGE_STATE: Readonly<Record<Coverage, SciState>> = {
  full: 'measured',
  'resident-only': 'preview',
  sampled: 'preview',
};

/** The active layer's basis (full, resident-only or sampled), or null with no scan. */
export function layerBasisProvider(facts: ScanFacts | null): StripFact<Coverage> | null {
  if (!facts) return null;
  return { value: facts.coverage, source: 'scan-facts', validity: COVERAGE_STATE[facts.coverage] };
}

// ── Open review and blocked states ──────────────────────────────────────────

export interface ReviewItem {
  readonly id: string;
  readonly state: 'review' | 'blocked';
}

export interface ReviewSummary {
  readonly count: number;
  readonly items: readonly ReviewItem[];
}

/**
 * Count the open review and blocked states: analysis rows whose status is
 * review or blocked, and results the index marks stale. `validity` is the
 * worst state present, or `measured` when nothing is open.
 */
export function reviewStateProvider(
  rows: readonly Pick<AnalysisRow, 'id' | 'status'>[],
  results: readonly Pick<ResultEntry, 'id' | 'status'>[],
): StripFact<ReviewSummary> {
  const items: ReviewItem[] = [];
  for (const r of rows) {
    if (r.status === 'review' || r.status === 'blocked') items.push({ id: `analysis:${r.id}`, state: r.status });
  }
  for (const r of results) {
    if (r.status === 'stale') items.push({ id: `result:${r.id}`, state: 'review' });
  }
  const worst: SciState = items.some((i) => i.state === 'blocked')
    ? 'blocked'
    : items.length > 0 ? 'review' : 'measured';
  return { value: { count: items.length, items }, source: 'analysis-rows+results-index', validity: worst };
}
