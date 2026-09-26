/**
 * streamingReportSeam.ts
 *
 * The shell's synchronous handle on the streaming Scan Report builder, which
 * lives in its own lazy chunk (`streamingScanReport.ts`) so the report code does
 * not ride the startup chunk.
 *
 * The chunk is preloaded when the first scan-open loaders warm (idle time, drag
 * intent, the URL picker). Once it has resolved, `runStreamingModules` returns
 * the rows synchronously, exactly as the static import did. Before that it
 * returns a Promise of the same rows, which every caller hands straight to
 * `Inspector.setReport` (it accepts either and owns the rejection, so a failed
 * chunk load shows the report load error rather than escaping as an unhandled
 * rejection). The report builder itself is unchanged, so the rows are the same.
 */
import type { AnalysisRow } from '../analysis/ModuleApi';
import type { SpatialContext } from '../geo/SpatialContext';
import type { StreamingReportCloud } from './streamingScanReport';
import { loadStreamingScanReport } from '../lazyChunks';

type StreamingReportModule = Awaited<ReturnType<typeof loadStreamingScanReport>>;

let loaded: StreamingReportModule | null = null;
let pending: Promise<StreamingReportModule> | null = null;

/** Start (or join) the one load of the report chunk. A failed load is retried on the next call. */
export function preloadStreamingReport(): Promise<StreamingReportModule> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= loadStreamingScanReport().then(
    (m) => (loaded = m),
    (err: unknown) => { pending = null; throw err; },
  );
  return pending;
}

/** Streaming report rows: synchronous once the chunk is loaded, a Promise of the same rows before. */
export function runStreamingModules(
  cloud: StreamingReportCloud,
  ctx: SpatialContext,
  classFilterActive = false,
): AnalysisRow[] | Promise<AnalysisRow[]> {
  if (loaded) return loaded.runStreamingModules(cloud, ctx, classFilterActive);
  return preloadStreamingReport().then((m) => m.runStreamingModules(cloud, ctx, classFilterActive));
}
