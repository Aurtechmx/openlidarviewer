/**
 * observatoryFromCloud.test.ts — the O9 coordinator's own glue: eligibility,
 * and a real (small) run of the O1-O8 pipeline over a fake cloud shaped like
 * `PointCloud` plus `AcquisitionStations` (OB-INT-02), resident-only basis.
 */
import { describe, it, expect } from 'vitest';
import { observatoryEligibility, runObservatoryOverCloud, type ObservatoryCloudInput } from '../src/app/observatoryFromCloud';
import type { AcquisitionStation } from '../src/model/AcquisitionStations';

function station(id: string, start: number, end: number, origin: readonly [number, number, number]): AcquisitionStation {
  return { id, source: 'ptx-block', pose: { worldTranslation: origin, localPositionSource: 'not-applicable' }, recordRange: { start, end }, originStatus: 'DECLARED' };
}

describe('observatoryEligibility', () => {
  const bounded: ObservatoryCloudInput = {
    positions: new Float32Array([0, 0, 0, 1, 1, 1]),
    sourceOrigin: [0, 0, 0],
    bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
  };

  it('no acquisitionStations -> ineligible (no-stations)', () => {
    expect(observatoryEligibility(bounded)).toEqual({ eligible: false, reason: 'no-stations' });
  });

  it('empty stations list -> ineligible (no-stations)', () => {
    const cloud = { ...bounded, acquisitionStations: { kind: 'acquisition-stations' as const, stations: [] } };
    expect(observatoryEligibility(cloud)).toEqual({ eligible: false, reason: 'no-stations' });
  });

  it('a degenerate (zero-extent) bounds box -> ineligible (empty-domain)', () => {
    const cloud: ObservatoryCloudInput = {
      ...bounded,
      bounds: () => ({ min: [0, 0, 0], max: [0, 0, 0] }),
      acquisitionStations: { kind: 'acquisition-stations', stations: [station('s1', 0, 1, [0, 0, 0])] },
    };
    expect(observatoryEligibility(cloud)).toEqual({ eligible: false, reason: 'empty-domain' });
  });

  it('declared stations plus a real bounds box -> eligible', () => {
    const cloud: ObservatoryCloudInput = {
      ...bounded,
      acquisitionStations: { kind: 'acquisition-stations', stations: [station('s1', 0, 1, [0, 0, 0])] },
    };
    expect(observatoryEligibility(cloud)).toEqual({ eligible: true });
  });
});

describe('runObservatoryOverCloud — a real small run', () => {
  // One station at the origin, a handful of resident points forming a small
  // wall-like cluster around x=5, plus points closer in (which the traversal
  // then passes through on the way to the far ones).
  // Domain y/z voxel boundaries fall on multiples of 0.5 starting at -1, so a
  // jitter of 0.05 around y=z=0.2 (safely mid-voxel, not near a 0/0.5 edge)
  // keeps all five returns in the SAME voxel — five distinct rays, one hit
  // voxel, n_min=5 met exactly.
  const positions = new Float32Array([
    5, 0.20, 0.20, 5, 0.21, 0.20, 5, 0.19, 0.20, 5, 0.20, 0.21, 5, 0.20, 0.19,
    2, 0, 0, // a lone near point on roughly the same bearing
  ]);
  const cloud: ObservatoryCloudInput = {
    positions,
    sourceOrigin: [0, 0, 0],
    bounds: () => ({ min: [0, -1, -1], max: [6, 1, 1] }),
    acquisitionStations: {
      kind: 'acquisition-stations',
      stations: [station('station-1', 0, positions.length / 3, [0, 0, 0])],
    },
  };

  it('produces an ok outcome with resident-only basis and a sealed run record', () => {
    const outcome = runObservatoryOverCloud(cloud, { voxelEdge: 0.5, declaredStepBudget: 1_000_000, filename: 'fixture.ptx', metresPerUnit: 1, buildTag: 'test' });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.record.source.basis).toBe('resident-only');
    expect(outcome.record.stations).toHaveLength(1);
    expect(outcome.record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.record.fieldDigest.length).toBeGreaterThan(0);
    // Every ray from the origin hit one of the five resident points, so
    // SURFACE evidence must exist somewhere in the field.
    expect(outcome.record.stateCounts.SURFACE).toBeGreaterThan(0);
  });

  it('is deterministic: the same cloud and options reproduce the same digest', () => {
    const options = { voxelEdge: 0.5, declaredStepBudget: 1_000_000, filename: 'fixture.ptx', metresPerUnit: 1, buildTag: 'test' };
    const a = runObservatoryOverCloud(cloud, options);
    const b = runObservatoryOverCloud(cloud, options);
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('test setup: expected both runs to succeed');
    expect(a.record.fieldDigest).toBe(b.record.fieldDigest);
  });

  it('an ineligible cloud is reported honestly, never run', () => {
    const noStations: ObservatoryCloudInput = { positions, sourceOrigin: [0, 0, 0], bounds: cloud.bounds };
    const outcome = runObservatoryOverCloud(noStations, { voxelEdge: 0.5, declaredStepBudget: 1_000_000, filename: null, metresPerUnit: null, buildTag: 'test' });
    expect(outcome).toEqual({ status: 'ineligible', reason: 'no-stations' });
  });
});
