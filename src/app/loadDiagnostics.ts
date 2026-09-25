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

/** How long {@link reportLoadDiagnostics} waits for the first drawn frame. */
export const FIRST_DRAW_TIMEOUT_MS = 10_000;

/**
 * Print and display the merged telemetry of one committed cloud. When
 * `firstDraw` is given, the report waits for it (up to
 * {@link FIRST_DRAW_TIMEOUT_MS}) and records it as `firstDrawMs`; a frame that
 * never draws (a hidden tab) leaves the field absent.
 */
export async function reportLoadDiagnostics(
  deps: LoadDiagnosticsDeps,
  cloud: Pick<PointCloud, 'name' | 'sourceFormat' | 'pointCount' | 'declaredPointCount'>,
  loadTelemetry: LoadTelemetry,
  firstDraw?: Promise<number>,
): Promise<void> {
  let telemetry = loadTelemetry;
  if (firstDraw) {
    let timer: number | undefined;
    const timeout = new Promise<undefined>((resolve) => { timer = window.setTimeout(resolve, FIRST_DRAW_TIMEOUT_MS); });
    const firstDrawMs = await Promise.race([firstDraw, timeout]);
    clearTimeout(timer);
    if (firstDrawMs !== undefined) telemetry = { ...telemetry, firstDrawMs };
  }
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
