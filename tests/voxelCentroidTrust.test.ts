/**
 * A voxel-reduced display sample holds centroids, not returns. An endpoint
 * snapped to one is not "on a measured return", so the trust grade caps at
 * caution and says what it snapped to.
 */
import { describe, expect, it } from 'vitest';
import { ProjectSnapIndex, eligibleSnapLayers, type SnapLayerEntry } from '../src/render/measure/projectSnap';
import { gradeMeasurement } from '../src/render/measure/measurementTrust';
import { PointCloud } from '../src/model/PointCloud';

function grid(n: number): Float32Array {
  const a: number[] = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) a.push(x * 0.1, y * 0.1, 0);
  return new Float32Array(a);
}

function entry(reduced: boolean): SnapLayerEntry {
  const cloud = new PointCloud({
    positions: grid(30), origin: [0, 0, 0], sourceFormat: 'las', name: 'c',
    ...(reduced ? { pointReduction: 'voxel-centroids' as const } : {}),
  });
  return { cloud, mesh: { visible: true } };
}

const REASON = 'snapped to a voxel centroid of the display sample, not a return';

describe('voxel-centroid snap support', () => {
  it('eligible layers carry the reduction', () => {
    const [layer] = eligibleSnapLayers([['a', entry(true)]], false);
    expect(layer.reduced).toBe(true);
    const [whole] = eligibleSnapLayers([['a', entry(false)]], false);
    expect(whole.reduced).toBe(false);
  });

  it('support marks an endpoint on a centroid', () => {
    const s = new ProjectSnapIndex();
    s.setProvider(() => eligibleSnapLayers([['a', entry(true)]], false));
    const v = s.support([1, 1, 0]);
    expect(v.snappedToPoint).toBe(true);
    expect(v.onReducedSample).toBe(true);
  });

  it('a real return on a whole layer is not marked', () => {
    const s = new ProjectSnapIndex();
    s.setProvider(() => eligibleSnapLayers([['a', entry(true)], ['b', entry(false)]], false));
    expect(s.support([1, 1, 0]).onReducedSample).toBe(false);
  });

  it('the grade caps at caution with the reason', () => {
    const s = new ProjectSnapIndex();
    s.setProvider(() => eligibleSnapLayers([['a', entry(true)]], false));
    const t = gradeMeasurement({ vertices: [s.support([1, 1, 0]), s.support([2, 2, 0])], crsKnown: true });
    expect(t.grade).toBe('yellow');
    expect(t.caption).not.toContain('measured points');
    expect(t.reasons.join(' ')).toContain(REASON);
    expect(t.reasons.join(' ')).not.toMatch(/measured return/);
  });

  it('whole data still grades green', () => {
    const s = new ProjectSnapIndex();
    s.setProvider(() => eligibleSnapLayers([['b', entry(false)]], false));
    const t = gradeMeasurement({ vertices: [s.support([1, 1, 0]), s.support([2, 2, 0])], crsKnown: true });
    expect(t.grade).toBe('green');
  });
});
