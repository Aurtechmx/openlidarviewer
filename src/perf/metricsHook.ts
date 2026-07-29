/**
 * metricsHook.ts
 *
 * Expose the debug overlay's metrics document on `window` for the performance
 * harness, mirroring the `__olvTerrainRasterEngine` verification hook.
 *
 * The harness reads the document the overlay already builds rather than
 * standing up a second telemetry path. Two paths would eventually disagree,
 * and the one a developer watches while diagnosing is the one a measurement
 * should quote.
 *
 * Registered only on the `?debug=1` route, so a normal session neither loads
 * the diagnostics chunk nor gains the hook.
 */

/** The shape the harness calls. */
export interface MetricsHook {
  __olvMetrics?: () => string;
}

/** Publish `read` as `window.__olvMetrics`. */
export function registerMetricsHook(read: () => string): void {
  (window as unknown as MetricsHook).__olvMetrics = read;
}
