/**
 * streamingDiagnosticsFixture.ts — the shared streaming-diagnostics test fixture.
 *
 * A mid-load scheduler snapshot used by both streamingDiagnostics.test.ts (the
 * record) and streamingDiagnosticsFormat.test.ts (the text rendering). Kept in
 * one place so the two suites assert on the same numbers rather than each
 * carrying its own copy.
 */
import type { SchedulerDiagnosticsExtra } from '../../src/render/streaming/streamingDiagnostics';
import type { SchedulerReadinessFacts } from '../../src/render/streaming/refinementReadiness';

/** A mid-load wanted set: 60 of 100 resident, work still moving. */
export const FACTS: SchedulerReadinessFacts = {
  wantedCount: 100,
  residentCount: 60,
  inFlightCount: 4,
  queuedCount: 36,
  decodedPendingCount: 2,
  failedCount: 1,
};

/** Everything the scheduler reports today, with no optional field supplied. */
export function extra(overrides: Partial<SchedulerDiagnosticsExtra> = {}): SchedulerDiagnosticsExtra {
  return {
    knownNodes: 28_000,
    visibleNodes: 140,
    residentPoints: 3_200_000,
    decodedPendingPoints: 51_000,
    pointBudget: 5_000_000,
    lastTickMs: 2.5,
    cameraVelocity: 0.75,
    cameraStable: true,
    effectiveMaxConcurrent: 3,
    pressureDepthReduction: 1,
    fpsBudgetFactor: 0.85,
    fullRescoreCount: 12,
    cacheBytes: 8_388_608,
    cacheEntries: 64,
    cacheMaxBytes: 16_777_216,
    cacheHits: 900,
    cacheMisses: 100,
    cacheEvictions: 7,
    ...overrides,
  };
}
