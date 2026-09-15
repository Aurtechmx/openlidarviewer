/**
 * loadDiagnostics.ts
 *
 * The developer readouts of a finished local load: the `?debug=1` telemetry
 * block, the performance overlay feed and the `?benchmark=1` result. Loaded
 * on demand from `openScan` through `lazyChunks.loadLoadDiagnostics`, so the
 * formatters stay out of the eager shell for the sessions that never ask.
 */
import { formatTelemetry, type LoadTelemetry } from '../io/loadTelemetry';
import { buildBenchmarkResult, formatBenchmarkResult } from '../io/benchmark';
import type { DebugOverlay } from '../ui/DebugOverlay';
import type { PointCloud } from '../model/PointCloud';

export interface LoadDiagnosticsDeps {
  readonly debug: boolean;
  readonly benchmark: boolean;
  getDebugOverlay(): Pick<DebugOverlay, 'setTelemetry' | 'setBenchmark'> | null;
}

/** Print and display the merged telemetry of one committed cloud. */
export function reportLoadDiagnostics(
  deps: LoadDiagnosticsDeps,
  cloud: Pick<PointCloud, 'name' | 'sourceFormat' | 'pointCount' | 'declaredPointCount'>,
  telemetry: LoadTelemetry,
): void {
  if (deps.debug) {
    console.log(
      '%cOpenLiDARViewer — load telemetry',
      'font-weight:600;color:#22dcff',
      '\n' + formatTelemetry(telemetry),
    );
  }
  deps.getDebugOverlay()?.setTelemetry(telemetry);
  if (deps.benchmark) {
    const text = formatBenchmarkResult(
      buildBenchmarkResult(
        cloud.name,
        cloud.sourceFormat,
        cloud.pointCount,
        telemetry,
        // Surface the header-declared point count when the source had
        // one, so the benchmark output disambiguates "4M of 100M (4 %)"
        // from "4M of 4M (100 %)" — a budget-capped load shouldn't
        // read identically to a full one.
        cloud.declaredPointCount,
      ),
    );
    console.log(
      '%cOpenLiDARViewer — benchmark',
      'font-weight:600;color:#22dcff',
      '\n' + text,
    );
    deps.getDebugOverlay()?.setBenchmark('benchmark\n' + text);
  }
}
