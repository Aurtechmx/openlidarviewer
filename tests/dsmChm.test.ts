import { describe, it, expect } from 'vitest';
import { reconstructDsmChm } from '../src/terrain/export/demPackage';

// A 2×2 grid. DTM = 10 everywhere (all covered). Canopy height defined in two
// cells (2 m and 5 m), NaN in the others.
//   index: 0 1 2 3
//   dtm.z: 10 10 10 10
//   cov:    2  2  2  2
//   canopy: 2  NaN  5  NaN
const DTM_Z = new Float32Array([10, 10, 10, 10]);
const DTM_COV = new Uint8Array([2, 2, 2, 2]);
const CANOPY = new Float32Array([2, NaN, 5, NaN]);

describe('reconstructDsmChm', () => {
  it('reconstructs DSM = DTM + canopy where canopy is defined', () => {
    const out = reconstructDsmChm(DTM_Z, DTM_COV, CANOPY);
    // Cell 0: 10 + 2 = 12, covered.
    expect(out.dsmZ[0]).toBeCloseTo(12, 5);
    expect(out.dsmCov[0]).toBe(1);
    // Cell 2: 10 + 5 = 15, covered.
    expect(out.dsmZ[2]).toBeCloseTo(15, 5);
    expect(out.dsmCov[2]).toBe(1);
  });

  it('reports CHM coverage exactly where canopy height is finite', () => {
    const out = reconstructDsmChm(DTM_Z, DTM_COV, CANOPY);
    expect(out.chmCov[0]).toBe(1);
    expect(out.chmCov[1]).toBe(0); // NaN canopy → no CHM
    expect(out.chmCov[2]).toBe(1);
    expect(out.chmCov[3]).toBe(0);
  });

  it('propagates nodata: no DSM/CHM where canopy is NaN', () => {
    const out = reconstructDsmChm(DTM_Z, DTM_COV, CANOPY);
    expect(out.dsmCov[1]).toBe(0);
    expect(out.dsmCov[3]).toBe(0);
    expect(out.chmCov[1]).toBe(0);
    expect(out.chmCov[3]).toBe(0);
  });

  it('does not synthesise DSM where the DTM has no ground', () => {
    // DTM uncovered at cell 0 even though canopy is finite there.
    const dtmCov = new Uint8Array([0, 2, 2, 2]);
    const out = reconstructDsmChm(DTM_Z, dtmCov, CANOPY);
    // CHM still defined (canopy height is a measured above-ground figure)…
    expect(out.chmCov[0]).toBe(1);
    // …but DSM cannot be reconstructed without a ground reference.
    expect(out.dsmCov[0]).toBe(0);
  });
});
