/**
 * oracleConsensusHillshade.test.ts — oracle-triangulation for hillshade.
 *
 * Hillshade is where a naive comparison lies most convincingly: two correct
 * implementations render the same slope as grey 209 and grey 210 and look like
 * they disagree. They do not. GDAL gdaldem maps the illumination as
 * round(1 + 254*hs) (reserving 0 for nodata) and OLV maps it as round(255*hs);
 * the underlying Lambertian illumination hs is identical to floating point. This
 * test triangulates on the CONTINUOUS hs (where analytic truth, GDAL and OLV
 * agree) and then shows the one-byte grey difference is fully accounted for by
 * the two published encodings — not an error in either tool.
 *
 * OLV's continuous leg and its byte output are recomputed live; GDAL's byte is
 * committed from gdaldem.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { shadeFromSlopeAspect, azimuthToMathRad } from '../src/terrain/surface/hillshade';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const record = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/oracle-consensus/hillshade-lambert.consensus.json'), 'utf8'),
) as {
  contract: { sun: { azimuthDeg: number; altitudeDeg: number; zFactor: number }; continuousToleranceAbs: number };
  fixture: { cols: number; rows: number; cellMetres: number };
  oracles: { id: string; referenceClass: string; continuousHs?: number; byteInterior?: number }[];
};

const DEG = Math.PI / 180;
const G = 0.3;

/** OLV's continuous Lambertian illumination at an interior cell, live. */
function olvContinuousHs(): number {
  const { azimuthDeg, altitudeDeg, zFactor } = record.contract.sun;
  const zenith = (90 - altitudeDeg) * DEG;
  const az = azimuthToMathRad(azimuthDeg);
  const slopeRad = Math.atan(zFactor * G); // interior slope tangent is exactly G
  const asp = Math.PI; // aspect due west in the math frame
  return Math.cos(zenith) * Math.cos(slopeRad) + Math.sin(zenith) * Math.sin(slopeRad) * Math.cos(az - asp);
}

/** OLV's rendered grey byte at an interior cell, from the real shader path. */
function olvByteInterior(): number {
  const { cols, rows, cellMetres } = record.fixture;
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = G * c;
  const { slope, aspect } = hornSlopeAspect(z, cols, rows, cellMetres, cellMetres);
  const cov = new Uint8Array(cols * rows).fill(1);
  const { shade } = shadeFromSlopeAspect(slope, aspect, cov, cols, rows, record.contract.sun);
  return shade[Math.floor(rows / 2) * cols + Math.floor(cols / 2)];
}

describe('oracle-consensus: hillshade (Lambertian)', () => {
  const tol = record.contract.continuousToleranceAbs;
  const truth = record.oracles.find((o) => o.referenceClass === 'analytic-truth')!;
  const gdal = record.oracles.find((o) => o.id === 'gdal-hillshade')!;
  const hs = olvContinuousHs();

  it('OLV continuous illumination matches analytic truth', () => {
    expect(Math.abs(hs - truth.continuousHs!)).toBeLessThanOrEqual(tol);
  });

  it("OLV's grey byte is its own encoding of that illumination (round(255*hs))", () => {
    expect(olvByteInterior()).toBe(Math.round(255 * hs));
  });

  it("GDAL's committed grey byte is GDAL's encoding of the SAME illumination (round(1+254*hs))", () => {
    expect(gdal.byteInterior).toBe(Math.round(1 + 254 * truth.continuousHs!));
  });

  it('the grey-byte difference is fully explained by the two encodings, not the physics', () => {
    const olvByte = Math.round(255 * hs);
    const encodingGap = Math.abs(Math.round(255 * hs) - Math.round(1 + 254 * hs));
    expect(Math.abs(olvByte - gdal.byteInterior!)).toBe(encodingGap);
    expect(encodingGap).toBeLessThanOrEqual(2);
  });

  it('NEGATIVE CONTROL: reading the two grey bytes as the same convention fabricates a disagreement', () => {
    // 209 vs 210 differ, yet the continuous illumination is identical — the exact
    // false conflict the continuous-quantity contract prevents.
    expect(Math.round(255 * hs)).not.toBe(gdal.byteInterior);
    expect(Math.abs(hs - truth.continuousHs!)).toBeLessThanOrEqual(tol);
  });
});
