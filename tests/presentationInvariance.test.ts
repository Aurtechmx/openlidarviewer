/**
 * Presentation settings never change a scientific result.
 *
 * Results digested (tests/helpers/scientificDigests.ts):
 *   - terrain DTM grid       sampleStridedTerrain → computeTerrainCore → dtmProductDigest
 *   - lasso stockpile result computeLassoVolume → deriveVolumeRecord → lassoStockpileResult
 *   - profile                profileSectionSeam sampleSeries (derived series) and section (returns)
 *   - scan-report density    scanReport 'Density' row
 *
 * Fixture: a 40 × 40 static layer with a mound, ASPRS classes 1/2, every 11th
 * point Withheld (lifted 30 units so a leak moves every figure) and every 5th
 * point Overlap; the streaming scene adds a five-node streamed neighbour.
 *
 * Settings matrix (48 cells), each resolved through the app's own policy:
 *   - device pixel ratio        {0.5, 1, 2}, capped by qualitySettingsFor().maxPixelRatio
 *   - Eye Dome Lighting         {on, off}, gated by frameBudgetPolicy().allowEdl
 *   - presentation point budget {low, default}: qualitySettingsFor at the Speed end
 *                               and at the Balanced midpoint → streamingPointBudget
 *   - frame budget governor     the wired governor (GovernorWiring, as `?governor=on`
 *                               installs it) fed a nominal ('idle') and a stressed
 *                               ('moving', loaded) frame window → dprPressure applied to
 *                               the DPR step, allowEdl to the EDL gate, hover
 *   - camera pose               two top-down orthographic cameras (different centre and
 *                               zoom); the lasso is the same world footprint projected
 *                               through each pose's projector
 *   - hover / probe             not in the matrix: none of the four paths takes a hover,
 *                               probe or allowDetailedHover input
 *
 * The lasso projector is sized in CSS pixels, as the Viewer sizes it from
 * canvas.clientWidth/clientHeight, so DPR and governor pressure change only the
 * backing store.
 *
 * On a streamed scene the presentation point budget sets the resident node
 * set, and every result that reads resident nodes changes with it. The
 * contract asserted there: each such result declares a resident basis
 * (profile residentOnly / section streamingComplete=false, stockpile grid
 * authority 'preview', DTM residentOnly), and results are identical for an
 * identical resident set.
 */
import { describe, it, expect } from 'vitest';
import {
  dtmOutcome,
  profileOutcome,
  resolvePresentation,
  residentNodes,
  scanReportDensity,
  staticScene,
  stockpileOutcome,
  streamingScene,
  STATIC_LASSO_WORLD,
  STRADDLE_LASSO_WORLD,
  WITHHELD_LIFT,
  type BudgetSetting,
  type GovernorSetting,
  type PoseId,
  type PresentationSettings,
  type ResolvedPresentation,
} from './helpers/scientificDigests';

const DPRS = [0.5, 1, 2] as const;
const EDLS = [true, false] as const;
const BUDGETS: readonly BudgetSetting[] = ['low', 'default'];
const GOVERNORS: readonly GovernorSetting[] = ['nominal', 'stressed'];
const POSES: readonly PoseId[] = ['A', 'B'];

const MATRIX: ResolvedPresentation[] = [];
for (const dpr of DPRS) for (const edl of EDLS) for (const budget of BUDGETS)
  for (const governor of GOVERNORS) for (const pose of POSES) {
    const s: PresentationSettings = { dpr, edl, budget, governor, pose };
    MATRIX.push(resolvePresentation(s));
  }

const label = (rp: ResolvedPresentation): string => {
  const s = rp.settings;
  return `dpr=${s.dpr} edl=${s.edl} budget=${s.budget} governor=${s.governor} pose=${s.pose}`;
};

describe('presentation matrix', () => {
  it('covers 48 presentation states', () => {
    expect(MATRIX).toHaveLength(48);
    const drawn = new Set(MATRIX.map((rp) => `${rp.backingPixelRatio}|${rp.edlDrawn}|${rp.streamingPointBudget}|${rp.policy.band}|${rp.pose}`));
    expect(drawn.size).toBeGreaterThan(12);
  });

  it('really varies what the renderer draws with', () => {
    expect(new Set(MATRIX.map((rp) => rp.streamingPointBudget)).size).toBe(2);
    expect(new Set(MATRIX.map((rp) => rp.policy.band))).toEqual(new Set(['idle', 'moving']));
    expect(new Set(MATRIX.map((rp) => rp.policy.allowDetailedHover))).toEqual(new Set([true, false]));
    expect(new Set(MATRIX.map((rp) => rp.edlDrawn))).toEqual(new Set([true, false]));
    expect(new Set(MATRIX.map((rp) => rp.backingPixelRatio)).size).toBeGreaterThan(2);
  });
});

describe('static scene: every result is identical across the whole matrix', () => {
  const scene = staticScene();

  it('DTM product digest', () => {
    const ref = dtmOutcome(scene, MATRIX[0]);
    expect(ref.withheldExcluded).toBe(true);
    expect(ref.withheldExcludedCount).toBeGreaterThan(0);
    expect(ref.residentOnly).toBe(false);
    for (const rp of MATRIX) expect(dtmOutcome(scene, rp).digest, label(rp)).toBe(ref.digest);
  });

  it('lasso stockpile result', () => {
    const ref = stockpileOutcome(scene, MATRIX[0], STATIC_LASSO_WORLD);
    expect(ref.streamingContributed).toBe(false);
    expect(ref.record.gridAuthority).toBe('measured');
    expect(ref.record.withheld?.excluded).toBeGreaterThan(0);
    // No Withheld point reached the figure: the mound peaks near 6, a leak sits at 30+.
    expect(ref.maxSelectedZ).toBeLessThan(WITHHELD_LIFT);
    for (const rp of MATRIX) {
      expect(stockpileOutcome(scene, rp, STATIC_LASSO_WORLD).digest, label(rp)).toBe(ref.digest);
    }
  });

  it('profile series and section', () => {
    const ref = profileOutcome(scene, MATRIX[0]);
    expect(ref.residentOnly).toBe(false);
    for (const rp of MATRIX) {
      const o = profileOutcome(scene, rp);
      expect(o.seriesDigest, label(rp)).toBe(ref.seriesDigest);
      expect(o.sectionDigest, label(rp)).toBe(ref.sectionDigest);
    }
  });

  it('scan-report density', () => {
    const ref = scanReportDensity(scene);
    expect(ref).toMatch(/^info:\d/);
    for (const rp of MATRIX) {
      void rp;
      expect(scanReportDensity(scene)).toBe(ref);
    }
  });
});

describe('streamed scene: results follow the resident set, and say so', () => {
  const scene = streamingScene();
  const residentKey = (rp: ResolvedPresentation): string =>
    residentNodes(scene, rp.streamingPointBudget).map((n) => n.key).join(',');

  it('the two budgets admit different resident sets, neither complete', () => {
    const keys = new Set(MATRIX.map(residentKey));
    expect(keys.size).toBe(2);
    for (const rp of MATRIX) {
      expect(residentNodes(scene, rp.streamingPointBudget).length).toBeLessThan(scene.nodes.length);
    }
  });

  /** Group the matrix by resident set and require one digest per group. */
  function expectOneDigestPerResidentSet(digest: (rp: ResolvedPresentation) => string): void {
    const byKey = new Map<string, string>();
    for (const rp of MATRIX) {
      const k = residentKey(rp);
      const d = digest(rp);
      const prev = byKey.get(k);
      if (prev === undefined) byKey.set(k, d);
      else expect(d, `${label(rp)} resident=${k}`).toBe(prev);
    }
  }

  it('DTM: declared resident-only; identical for an identical resident set', () => {
    for (const rp of MATRIX) expect(dtmOutcome(scene, rp).residentOnly).toBe(true);
    expectOneDigestPerResidentSet((rp) => dtmOutcome(scene, rp).digest);
  });

  it('lasso stockpile: declared streaming and preview; identical for an identical resident set', () => {
    for (const rp of MATRIX) {
      const o = stockpileOutcome(scene, rp, STRADDLE_LASSO_WORLD);
      expect(o.streamingContributed).toBe(true);
      expect(o.record.gridAuthority).toBe('preview');
    }
    expectOneDigestPerResidentSet((rp) => stockpileOutcome(scene, rp, STRADDLE_LASSO_WORLD).digest);
  });

  it('profile: declared resident-only and incomplete; identical for an identical resident set', () => {
    for (const rp of MATRIX) {
      const o = profileOutcome(scene, rp);
      expect(o.residentOnly).toBe(true);
      expect(o.streamingComplete).toBe(false);
    }
    expectOneDigestPerResidentSet((rp) => {
      const o = profileOutcome(scene, rp);
      return `${o.seriesDigest}|${o.sectionDigest}`;
    });
  });

  it('the budget does move resident-basis results (the declaration is load-bearing)', () => {
    const low = MATRIX.find((rp) => rp.settings.budget === 'low')!;
    const def = MATRIX.find((rp) => rp.settings.budget === 'default')!;
    expect(dtmOutcome(scene, low).digest).not.toBe(dtmOutcome(scene, def).digest);
    expect(stockpileOutcome(scene, low, STRADDLE_LASSO_WORLD).digest)
      .not.toBe(stockpileOutcome(scene, def, STRADDLE_LASSO_WORLD).digest);
    expect(profileOutcome(scene, low).seriesDigest).not.toBe(profileOutcome(scene, def).seriesDigest);
  });

  it('scan-report density reads the static layer only and does not move', () => {
    const ref = scanReportDensity(scene);
    for (const rp of MATRIX) { void rp; expect(scanReportDensity(scene)).toBe(ref); }
  });
});
