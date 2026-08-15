import { describe, it, expect } from 'vitest';
import { planPlacement, placeInProject } from '../src/geo/projectPlacement';
import type { GlobalPoints } from '../src/convert/globalPoints';

describe('planPlacement', () => {
  const both = { layerVerticalKnown: true, projectVerticalKnown: true };

  it('reprojects between two known projected CRSs, height comparable', () => {
    const p = planPlacement({ layerEpsg: 32611, projectEpsg: 32612, ...both });
    expect(p.horizontal).toBe('reproject');
    expect(p.verticalComparable).toBe(true);
    expect(p.reasonCode).toBe('REPROJECT');
  });

  it('is identity when the layer already matches the project CRS', () => {
    const p = planPlacement({ layerEpsg: 32612, projectEpsg: 32612, ...both });
    expect(p.horizontal).toBe('identity');
  });

  it('needs registration when the layer has no CRS', () => {
    const p = planPlacement({ layerEpsg: null, projectEpsg: 32612, ...both });
    expect(p.horizontal).toBe('needs-registration');
    expect(p.reasonCode).toBe('LAYER_NO_CRS');
  });

  it('needs a project CRS before any layer can reproject', () => {
    const p = planPlacement({ layerEpsg: 32611, projectEpsg: null, ...both });
    expect(p.reasonCode).toBe('NO_PROJECT_CRS');
  });

  it('withholds height comparability when a vertical datum is unresolved', () => {
    const p = planPlacement({ layerEpsg: 32611, projectEpsg: 32612, layerVerticalKnown: true, projectVerticalKnown: false });
    expect(p.horizontal).toBe('reproject'); // X/Y still placed
    expect(p.verticalComparable).toBe(false);
    expect(p.reason).toContain('withheld');
  });
});

describe('placeInProject', () => {
  it('moves X/Y between adjacent UTM zones and carries Z through', () => {
    // A point near the 11N/12N boundary; its easting changes across the zones.
    const g: GlobalPoints = {
      count: 1,
      x: Float64Array.from([500000]),
      y: Float64Array.from([4000000]),
      z: Float64Array.from([123.5]),
    };
    const res = placeInProject(g, 32611, 32612);
    expect(res.transformed).toBe(true);
    expect(res.points.x[0]).not.toBeCloseTo(500000, 0); // easting moved
    expect(res.points.z[0]).toBe(123.5); // Z unchanged
  });

  it('is a no-op when source and target CRS match', () => {
    const g: GlobalPoints = { count: 1, x: Float64Array.from([1]), y: Float64Array.from([2]), z: Float64Array.from([3]) };
    expect(placeInProject(g, 32612, 32612).transformed).toBe(false);
  });
});
