import { describe, expect, it } from 'vitest';

import { buildObservationPointColors, type ObservationFieldValues } from '../src/render/observation/observationColorModes';
import { computeFieldDigest, domainGrid, packVoxelKey, type ObservationDomain, type RayPartitionInput } from '../src/observation/ledger';
import type { AcquisitionStation } from '../src/model/AcquisitionStations';
import type { ObservationState } from '../src/observation/types';
import type { ObservationStrengthComponents } from '../src/observation/strength';

const domain: ObservationDomain = { min: [0, 0, 0], max: [4, 4, 4] };
const voxelEdge = 1;
const { nx, ny } = domainGrid(domain, voxelEdge);

function station(id: string): AcquisitionStation {
  return {
    id,
    source: 'ptx-block',
    pose: { worldTranslation: [0, 0, 0], localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: 0 },
    originStatus: 'DECLARED',
  };
}

const digestInput: Pick<RayPartitionInput, 'domain' | 'voxelEdge' | 'stations' | 'returnedChunks'> = {
  domain,
  voxelEdge,
  stations: [station('s1')],
  returnedChunks: [],
};

function buildValues(): ObservationFieldValues {
  const key = packVoxelKey(1, 1, 1, nx, ny);
  const stateByKey = new Map<number, ObservationState>([[key, 'SURFACE']]);
  const strengthByKey = new Map<number, ObservationStrengthComponents>([
    [key, { sources: 1, angularSpread: 0.5, incidence: 0.8, rangeFit: 1, consistency: 0.9 }],
  ]);
  const hitFractionByKey = new Map<number, number>([[key, 0.75]]);
  return { stateByKey, strengthByKey, hitFractionByKey };
}

// One point dead-centre of voxel (1,1,1); one point outside the whole domain.
const positions = new Float32Array([1.5, 1.5, 1.5, 100, 100, 100]);

describe('OB-PR-01 — per-point colour modes (observationColorModes.ts)', () => {
  it('is deterministic: identical inputs produce byte-identical colours', () => {
    const values = buildValues();
    const a = buildObservationPointColors(positions, domain, voxelEdge, values, 'observationState');
    const b = buildObservationPointColors(positions, domain, voxelEdge, values, 'observationState');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('colours a point outside the domain distinctly from a resolved SURFACE voxel', () => {
    const values = buildValues();
    const colors = buildObservationPointColors(positions, domain, voxelEdge, values, 'observationState');
    const inside = [colors[0], colors[1], colors[2]];
    const outside = [colors[3], colors[4], colors[5]];
    expect(inside).not.toEqual(outside);
  });

  it('observationHitFraction and observationStrength map [0, 1] values into the byte range without clipping to the wrong end', () => {
    const values = buildValues();
    const hitColors = buildObservationPointColors(positions, domain, voxelEdge, values, 'observationHitFraction');
    // 0.75 maps to a mid-high grey, not 0 and not 255.
    expect(hitColors[0]).toBeGreaterThan(0);
    expect(hitColors[0]).toBeLessThan(255);

    const strengthColors = buildObservationPointColors(positions, domain, voxelEdge, values, 'observationStrength', 'incidence');
    expect(strengthColors[0]).toBeGreaterThan(0);
    expect(strengthColors[0]).toBeLessThan(255);
  });

  it('OB-INV-06: no presentation parameter — colour mode, strength component, or which arrays are consulted — moves fieldDigest', () => {
    const rows = [
      { key: packVoxelKey(1, 1, 1, nx, ny), counters: { hit: 1, pass: 0, behind: 0, noReturn: 0, saturated: false }, presence: new Uint32Array([1]), perSource: [] },
    ];
    const digestBefore = computeFieldDigest(digestInput, rows);

    const values = buildValues();
    buildObservationPointColors(positions, domain, voxelEdge, values, 'observationState');
    buildObservationPointColors(positions, domain, voxelEdge, values, 'observationStrength', 'rangeFit');
    buildObservationPointColors(positions, domain, voxelEdge, values, 'observationHitFraction');

    const digestAfter = computeFieldDigest(digestInput, rows);
    expect(digestAfter).toBe(digestBefore);
  });
});
