/**
 * scanRoute.test.ts
 *
 * The manual scan-type override is the safety net for a misdetection: a single
 * pure helper, `resolveScanRoute(detected, override)`, decides the EFFECTIVE
 * route. When the override is 'auto' the detected verdict wins (today's
 * behaviour, untouched); any non-auto override WINS over detection so a misread
 * 360 house is one click to fix.
 */

import { describe, it, expect } from 'vitest';
import { planScanRoute, resolveScanRoute } from '../src/terrain/scanRoute';
import type { ScanRouteInput, ScanTypeOverride } from '../src/terrain/scanRoute';
import type { SpaceKind } from '../src/terrain/scanShape';

const DETECTED: readonly SpaceKind[] = ['terrain', 'object', 'interior'];
const NON_AUTO: readonly ScanTypeOverride[] = ['terrain', 'object', 'interior'];

describe('resolveScanRoute — override wins over detection', () => {
  it("override 'auto' returns the detected verdict unchanged", () => {
    for (const detected of DETECTED) {
      expect(resolveScanRoute(detected, 'auto')).toBe(detected);
    }
  });

  it('a non-auto override decides the route regardless of detection', () => {
    for (const detected of DETECTED) {
      for (const override of NON_AUTO) {
        expect(resolveScanRoute(detected, override)).toBe(override);
      }
    }
  });

  it('the reported regression: detected object, forced interior → interior', () => {
    expect(resolveScanRoute('object', 'interior')).toBe('interior');
  });

  it('forcing terrain on a non-terrain scan → terrain', () => {
    expect(resolveScanRoute('interior', 'terrain')).toBe('terrain');
    expect(resolveScanRoute('object', 'terrain')).toBe('terrain');
  });
});

// ── planScanRoute — the FULL route matrix the host applies to the panels ─────
// The v0.4.5 regression: with "Treat as" on Auto, a 360 interior's terrain
// Surface-Quality/Analyse panel surfaced (and could run) on its own. The plan
// pins the two guarantees: terrain analysis NEVER auto-runs from detection,
// and a streaming re-evaluation NEVER flips the session to terrain.
describe('planScanRoute — route matrix', () => {
  const base: ScanRouteInput = {
    detected: null,
    override: 'auto',
    initial: true,
    lastVerdict: null,
    pinned: false,
  };

  it('interior-detected + auto ⇒ Object/Space panel, NO terrain panel, NO terrain run', () => {
    for (const initial of [true, false]) {
      const plan = planScanRoute({ ...base, detected: 'interior', initial, lastVerdict: initial ? null : 'object' });
      expect(plan.apply).toBe(true);
      expect(plan.effective).toBe('interior');
      expect(plan.showObjectPanel).toBe(true);
      expect(plan.showAnalysePanel).toBe(false);
      expect(plan.runTerrain).toBe(false);
    }
  });

  it('object-detected + auto ⇒ Object panel, Analyse hidden, no run', () => {
    const plan = planScanRoute({ ...base, detected: 'object' });
    expect(plan).toMatchObject({
      apply: true, effective: 'object',
      showObjectPanel: true, showAnalysePanel: false, runTerrain: false,
    });
  });

  it('terrain-detected + auto ⇒ Analyse panel shown but the pipeline NEVER auto-runs', () => {
    const plan = planScanRoute({ ...base, detected: 'terrain' });
    expect(plan.apply).toBe(true);
    expect(plan.effective).toBe('terrain');
    expect(plan.showAnalysePanel).toBe(true);
    expect(plan.showObjectPanel).toBe(false);
    expect(plan.runTerrain).toBe(false); // detection alone must not start an analysis
  });

  it("the explicit hatch / manual Terrain override ('terrain') still runs the pipeline", () => {
    // "Run terrain contours anyway" routes through the same override.
    for (const detected of ['interior', 'object', 'terrain', null] as const) {
      const plan = planScanRoute({ ...base, detected, override: 'terrain' });
      expect(plan.apply).toBe(true);
      expect(plan.effective).toBe('terrain');
      expect(plan.showAnalysePanel).toBe(true);
      expect(plan.showObjectPanel).toBe(false);
      expect(plan.runTerrain).toBe(true);
    }
  });

  it('manual Object / Interior overrides route without ever touching terrain', () => {
    for (const override of ['object', 'interior'] as const) {
      const plan = planScanRoute({ ...base, detected: 'terrain', override });
      expect(plan.apply).toBe(true);
      expect(plan.effective).toBe(override);
      expect(plan.showObjectPanel).toBe(true);
      expect(plan.showAnalysePanel).toBe(false);
      expect(plan.runTerrain).toBe(false);
    }
  });

  it('a streaming re-evaluation NEVER flips the session to terrain (the auto-open bug)', () => {
    // Mid-fill frame momentarily reads as terrain on a scan previously routed
    // interior/object — the exact path that auto-opened the Analyse panel.
    for (const lastVerdict of ['interior', 'object'] as const) {
      const plan = planScanRoute({ ...base, detected: 'terrain', initial: false, lastVerdict });
      expect(plan.apply).toBe(false);
      expect(plan.runTerrain).toBe(false);
      expect(plan.showAnalysePanel).toBe(false);
    }
  });

  it('a streaming re-evaluation still rescues an early terrain misread into interior', () => {
    const plan = planScanRoute({ ...base, detected: 'interior', initial: false, lastVerdict: 'terrain' });
    expect(plan.apply).toBe(true);
    expect(plan.effective).toBe('interior');
    expect(plan.showObjectPanel).toBe(true);
    expect(plan.showAnalysePanel).toBe(false);
    expect(plan.runTerrain).toBe(false);
  });

  it('re-evaluation no-ops when pinned, manually overridden, undecidable, or unchanged', () => {
    expect(planScanRoute({ ...base, detected: 'interior', initial: false, lastVerdict: 'terrain', pinned: true }).apply).toBe(false);
    expect(planScanRoute({ ...base, detected: 'interior', override: 'object', initial: false, lastVerdict: 'terrain' }).apply).toBe(false);
    expect(planScanRoute({ ...base, detected: null, initial: false, lastVerdict: 'terrain' }).apply).toBe(false);
    expect(planScanRoute({ ...base, detected: 'interior', initial: false, lastVerdict: 'interior' }).apply).toBe(false);
  });

  it('open-time with nothing detected + auto ⇒ default terrain panel, no run', () => {
    const plan = planScanRoute(base);
    expect(plan.apply).toBe(true);
    expect(plan.effective).toBe(null);
    expect(plan.showAnalysePanel).toBe(true);
    expect(plan.showObjectPanel).toBe(false);
    expect(plan.runTerrain).toBe(false);
  });
});

// ── planScanRoute — the settled soft-commit (v0.4.5 follow-up) ───────────────
// Once detection SETTLES (static-load open, or the streaming settle one-shot)
// the "Treat as" control moves its selection from Auto onto the detected pill.
// `commitDetected` is the planner's signal for that: detection-sourced (never
// a user override — routing semantics untouched), only under auto mode, only
// on settled geometry, and only when the settled verdict matches the route
// actually standing. A new scan resets the host flag (host-side; the planner
// is stateless).
describe('planScanRoute — settled soft-commit (commitDetected)', () => {
  const base: ScanRouteInput = {
    detected: null,
    override: 'auto',
    initial: true,
    lastVerdict: null,
    pinned: false,
    settled: false,
  };

  it('static-load detection (initial + settled + auto) commits the detected type', () => {
    for (const detected of DETECTED) {
      const plan = planScanRoute({ ...base, detected, settled: true });
      expect(plan.apply).toBe(true);
      expect(plan.commitDetected).toBe(detected);
    }
  });

  it('a settled terrain verdict commits the Terrain pill WITHOUT running the pipeline', () => {
    const plan = planScanRoute({ ...base, detected: 'terrain', settled: true });
    expect(plan.commitDetected).toBe('terrain');
    expect(plan.showAnalysePanel).toBe(true);
    expect(plan.runTerrain).toBe(false); // commit is display-only — never an analysis
  });

  it('the streaming settle one-shot commits even when the verdict is UNCHANGED (routing no-op)', () => {
    // The common case: open-time already routed interior, the settle re-eval
    // confirms it. Routing no-ops, but the pill must still move off Auto.
    const plan = planScanRoute({
      ...base, detected: 'interior', initial: false, lastVerdict: 'interior', settled: true,
    });
    expect(plan.apply).toBe(false);
    expect(plan.commitDetected).toBe('interior');
  });

  it('the settle one-shot that RESCUES an early terrain misread commits the rescue', () => {
    const plan = planScanRoute({
      ...base, detected: 'interior', initial: false, lastVerdict: 'terrain', settled: true,
    });
    expect(plan.apply).toBe(true);
    expect(plan.effective).toBe('interior');
    expect(plan.commitDetected).toBe('interior');
  });

  it('a settled terrain read against a standing interior route never commits (or applies)', () => {
    // The terrain-flip guard refuses the route, so the pill must not claim it
    // either — the control would otherwise contradict the visible panel.
    const plan = planScanRoute({
      ...base, detected: 'terrain', initial: false, lastVerdict: 'interior', settled: true,
    });
    expect(plan.apply).toBe(false);
    expect(plan.commitDetected).toBe(null);
  });

  it('unsettled evaluations NEVER commit (sparse mid-stream frames only route)', () => {
    for (const initial of [true, false]) {
      const plan = planScanRoute({
        ...base, detected: 'interior', initial, lastVerdict: initial ? null : 'object',
      });
      expect(plan.commitDetected).toBe(null);
    }
    // `settled` omitted entirely behaves the same.
    const { settled: _unused, ...withoutSettled } = { ...base, detected: 'interior' as const };
    void _unused;
    expect(planScanRoute(withoutSettled).commitDetected).toBe(null);
  });

  it('a manual override, a pin, or an undecidable verdict blocks the commit', () => {
    for (const override of NON_AUTO) {
      expect(
        planScanRoute({ ...base, detected: 'interior', override, settled: true }).commitDetected,
      ).toBe(null);
    }
    expect(
      planScanRoute({ ...base, detected: 'interior', pinned: true, settled: true }).commitDetected,
    ).toBe(null);
    expect(planScanRoute({ ...base, detected: null, settled: true }).commitDetected).toBe(null);
  });

  it('the commit never changes the routing decision itself', () => {
    // Same inputs ± settled ⇒ identical routing fields (commit is additive).
    for (const detected of [...DETECTED, null] as const) {
      for (const initial of [true, false]) {
        for (const lastVerdict of [...DETECTED, null] as const) {
          const a = planScanRoute({ ...base, detected, initial, lastVerdict, settled: false });
          const b = planScanRoute({ ...base, detected, initial, lastVerdict, settled: true });
          expect({
            apply: b.apply, effective: b.effective, showObjectPanel: b.showObjectPanel,
            showAnalysePanel: b.showAnalysePanel, runTerrain: b.runTerrain,
          }).toEqual({
            apply: a.apply, effective: a.effective, showObjectPanel: a.showObjectPanel,
            showAnalysePanel: a.showAnalysePanel, runTerrain: a.runTerrain,
          });
        }
      }
    }
  });
});
