/**
 * stripReads.ts — gather the state strip's provider inputs from the services
 * that own them, and run each provider once.
 *
 * Like `toolPreflightInput.ts`, this is a seam and nothing else: every read is
 * a thunk over an owner the shell already has, and each is allowed to throw.
 * A failing read drops that one item rather than the strip. No value is
 * computed here; the providers in `process/stateProviders.ts` select and
 * translate, and this module only hands them their inputs.
 */

import type { SpatialContext } from '../../geo/SpatialContext';
import type { ResolvedCrs } from '../../geo/CoordinateTypes';
import type { ScanFacts, Coverage } from '../../process/ProcessPlan';
import type { AnalysisRow } from '../../process/analysisStatus';
import type { ResultEntry } from '../results/resultsIndex';
import type { TaskActivity } from '../../process/taskActivity';
import {
  datasetNameProvider,
  horizontalCrsProvider,
  layerBasisProvider,
  processingProvider,
  reviewStateProvider,
  verticalReferenceProvider,
  type HorizontalCrs,
  type Processing,
  type ReviewSummary,
  type StripFact,
  type VerticalRef,
} from '../../process/stateProviders';

export interface StripLiveReads {
  /** `viewer.streamingCloud?.name`. */
  streamingName(): string | null | undefined;
  /** `ScanService.activeCloud()?.name`. */
  activeCloudName(): string | null | undefined;
  /** `CrsService.context()`. */
  spatialContext(): SpatialContext;
  /** `CrsService.current()`. */
  resolvedCrs(): ResolvedCrs | null;
  /** Process Studio's facts for the active scan. */
  scanFacts(): ScanFacts | null;
  /** The Analyse home's last published rows. */
  analysisRows(): readonly Pick<AnalysisRow, 'id' | 'status'>[];
  /** The results index entries. */
  results(): readonly Pick<ResultEntry, 'id' | 'status'>[];
  /** Live tasks from the task-activity store. */
  tasks(): readonly TaskActivity[];
}

export interface StripSnapshot {
  readonly dataset: StripFact;
  readonly horizontal: StripFact<HorizontalCrs> | null;
  readonly vertical: StripFact<VerticalRef> | null;
  readonly basis: StripFact<Coverage> | null;
  readonly processing: StripFact<Processing> | null;
  readonly review: StripFact<ReviewSummary> | null;
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Every item's fact, or null when no scan is open (no dataset name). */
export function readStrip(r: StripLiveReads): StripSnapshot | null {
  const dataset = safely(
    () => datasetNameProvider({ streamingName: r.streamingName(), activeCloudName: r.activeCloudName() }),
    null,
  );
  if (!dataset) return null;
  const context = safely(() => r.spatialContext(), null);
  const resolved = safely(() => r.resolvedCrs(), null);
  return {
    dataset,
    horizontal: context ? horizontalCrsProvider(context, resolved) : null,
    vertical: context ? verticalReferenceProvider(context) : null,
    basis: safely(() => layerBasisProvider(r.scanFacts()), null),
    processing: safely(() => processingProvider(r.tasks()), null),
    review: safely(() => reviewStateProvider(r.analysisRows(), r.results()), null),
  };
}
