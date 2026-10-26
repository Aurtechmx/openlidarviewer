/**
 * storageHistoryReport.ts: the storage-grid test for the scan report, scheduled per cloud.
 *
 * `runAnalysisModules` asks for the outcome while it builds the report rows. The first call
 * for a cloud decides synchronously whether the test can run (a resident LAS or LAZ with its
 * header grid, a non-geographic frame, enough points), copies the local X and Y out of the
 * position buffer and hands them to the worker; the row reads "test running" until the worker
 * answers, then every registered listener gets the settled outcome and the report is rebuilt.
 * Later calls for the same cloud and unit read the cached outcome, so a class filter change or
 * a camera move never runs the test twice.
 *
 * The cache is keyed by the cloud and by the metres-per-unit the frame resolves to, because
 * a user unit override changes which candidate grids are tested.
 */
import type { PointCloud } from '../model/PointCloud';
import type { SpatialContext } from '../geo/SpatialContext';
import { sourcePositions } from '../model/pointFrames';
import type { StorageHistoryOutcome } from '../analysis/storageHistoryRow';
import { MAX_RECOVERED_POINTS, MIN_POINTS, type StorageHistoryRequest } from '../science/storageHistory';
import { runStorageHistoryInWorker } from './storageHistoryWorkerClient';

interface Entry {
  outcome: StorageHistoryOutcome;
  listeners: ((outcome: StorageHistoryOutcome) => void)[];
}

const cache = new WeakMap<PointCloud, Map<string, Entry>>();

/** The cloud surface the test reads; `PointCloud` satisfies it, and tests can pass a stand-in. */
export interface StorageHistoryCloud {
  readonly sourceFormat: string;
  readonly pointCount: number;
  readonly sourceOrigin: readonly [number, number, number];
  readonly metadata?: {
    readonly sourceQuantisation?: {
      readonly scale: readonly [number, number, number];
      readonly offset: readonly [number, number, number];
    };
  };
}

/** The reason the test cannot run for this cloud and frame, or null when it can. */
export function storageHistoryRefusal(cloud: StorageHistoryCloud, ctx: SpatialContext | undefined): string | null {
  if (cloud.sourceFormat !== 'las' && cloud.sourceFormat !== 'laz') return 'not a LAS or LAZ file';
  if (!cloud.metadata?.sourceQuantisation) return 'stored integers not kept by this load';
  if (ctx?.isGeographic) return 'geographic coordinates';
  if (cloud.pointCount < MIN_POINTS) return 'too few points';
  return null;
}

/**
 * The worker request for `cloud`: the local X and Y of every point, strided to at most
 * `MAX_RECOVERED_POINTS`, with the header grid and the frame's metres per unit (null when
 * the unit is not established).
 */
export function storageHistoryRequest(cloud: PointCloud, ctx: SpatialContext | undefined): StorageHistoryRequest {
  const q = cloud.metadata?.sourceQuantisation as NonNullable<NonNullable<PointCloud['metadata']>['sourceQuantisation']>;
  const pos = sourcePositions(cloud);
  const n = cloud.pointCount;
  const stride = Math.max(1, Math.ceil(n / MAX_RECOVERED_POINTS));
  const m = Math.ceil(n / stride);
  const xy = new Float32Array(2 * m);
  for (let i = 0, j = 0; i < n; i += stride, j += 2) {
    xy[j] = pos[3 * i];
    xy[j + 1] = pos[3 * i + 1];
  }
  return {
    xy,
    sourceOrigin: [cloud.sourceOrigin[0], cloud.sourceOrigin[1]],
    scale: [q.scale[0], q.scale[1]],
    offset: [q.offset[0], q.offset[1]],
    unitToMetres: ctx?.linearUnitKnown ? ctx.linearUnitToMetres : null,
  };
}

/**
 * The storage-history outcome for `cloud` under `ctx`: settled when known, otherwise
 * `running` while the worker tests it, with `onSettled` called once when it ends.
 */
export function storageHistoryFor(
  cloud: PointCloud,
  ctx: SpatialContext | undefined,
  onSettled?: (outcome: StorageHistoryOutcome) => void,
): StorageHistoryOutcome {
  const refusal = storageHistoryRefusal(cloud, ctx);
  if (refusal) return { kind: 'not-tested', reason: refusal };
  const key = ctx?.linearUnitKnown ? String(ctx.linearUnitToMetres) : 'unknown-unit';
  let byUnit = cache.get(cloud);
  if (!byUnit) { byUnit = new Map(); cache.set(cloud, byUnit); }
  let entry = byUnit.get(key);
  if (!entry) {
    const made: Entry = { outcome: { kind: 'running' }, listeners: [] };
    entry = made;
    byUnit.set(key, made);
    const settle = (outcome: StorageHistoryOutcome): void => {
      made.outcome = outcome;
      const listeners = made.listeners.splice(0);
      for (const l of listeners) l(outcome);
    };
    runStorageHistoryInWorker(storageHistoryRequest(cloud, ctx)).then(settle, () => settle({ kind: 'not-tested', reason: 'the test did not finish' }));
  }
  if (entry.outcome.kind === 'running' && onSettled) entry.listeners.push(onSettled);
  return entry.outcome;
}
