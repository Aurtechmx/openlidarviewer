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
 * the two published encodings.
 *
 * Two cases run: a west-facing plane and an east-facing plane. The illumination
 * term cos(azimuth - aspect) has opposite sign contributions in the two, so a
 * sign error there produces the right answer in neither. OLV's legs are
 * recomputed live; GDAL's bytes are committed from gdaldem.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { shadeFromSlopeAspect, azimuthToMathRad } from '../src/terrain/surface/hillshade';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Sun = { azimuthDeg: number; altitudeDeg: number; zFactor: number };
type Oracle = { id: string; referenceClass: string; continuousHs?: number; byteInterior?: number };
type Case = {
  fixture: { cols: number; rows: number; cellMetres: number; gradient: number; aspectMathRad: number; model: string };
  oracles: Oracle[];
};
const record = JSON.parse(
  readFileSync(resolve(ROOT, 'validation/oracle-consensus/hillshade-lambert.consensus.json'), 'utf8'),
) as { contract: { sun: Sun; continuousToleranceAbs: number }; cases: Case[] };

const DEG = Math.PI / 180;

/** OLV's continuous Lambertian illumination for a case, live. */
function olvContinuousHs(c: Case, sun: Sun): number {
  const zenith = (90 - sun.altitudeDeg) * DEG;
  const az = azimuthToMathRad(sun.azimuthDeg);
  const slopeRad = Math.atan(sun.zFactor * c.fixture.gradient);
  const asp = c.fixture.aspectMathRad;
  return Math.cos(zenith) * Math.cos(slopeRad) + Math.sin(zenith) * Math.sin(slopeRad) * Math.cos(az - asp);
}

/** OLV's rendered grey byte at an interior cell, from the real shader path. */
function olvByteInterior(c: Case, sun: Sun): number {
  const { cols, rows, cellMetres, gradient } = c.fixture;
  const eastFacing = c.fixture.aspectMathRad === 0;
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let col = 0; col < cols; col++) z[r * cols + col] = gradient * (eastFacing ? cols - 1 - col : col);
  const { slope, aspect } = hornSlopeAspect(z, cols, rows, cellMetres, cellMetres);
  const cov = new Uint8Array(cols * rows).fill(1);
  const { shade } = shadeFromSlopeAspect(slope, aspect, cov, cols, rows, sun);
  return shade[Math.floor(rows / 2) * cols + Math.floor(cols / 2)];
}

describe('oracle-consensus: hillshade (Lambertian)', () => {
  const { sun } = record.contract;
  const tol = record.contract.continuousToleranceAbs;

  for (const c of record.cases) {
    const label = c.fixture.model;
    const truth = c.oracles.find((o) => o.referenceClass === 'analytic-truth')!;
    const gdal = c.oracles.find((o) => o.id === 'gdal-hillshade')!;
    const hs = olvContinuousHs(c, sun);

    it(`OLV continuous illumination matches analytic truth [${label}]`, () => {
      expect(Math.abs(hs - truth.continuousHs!)).toBeLessThanOrEqual(tol);
    });

    it(`OLV's grey byte is its own encoding round(255*hs) [${label}]`, () => {
      expect(olvByteInterior(c, sun)).toBe(Math.round(255 * hs));
    });

    it(`GDAL's committed grey byte is GDAL's encoding round(1+254*hs) of the same illumination [${label}]`, () => {
      expect(gdal.byteInterior).toBe(Math.round(1 + 254 * truth.continuousHs!));
    });

    it(`the grey-byte difference is fully explained by the two encodings, not the physics [${label}]`, () => {
      const olvByte = Math.round(255 * hs);
      const encodingGap = Math.abs(Math.round(255 * hs) - Math.round(1 + 254 * hs));
      expect(Math.abs(olvByte - gdal.byteInterior!)).toBe(encodingGap);
      expect(encodingGap).toBeLessThanOrEqual(2);
    });
  }

  it('the two cases are genuinely different operating points (a sign error could not pass both)', () => {
    const hsValues = record.cases.map((c) => olvContinuousHs(c, sun));
    expect(Math.abs(hsValues[0] - hsValues[1])).toBeGreaterThan(0.2);
  });

  it('NEGATIVE CONTROL: reading the two grey bytes as one convention fabricates a disagreement', () => {
    for (const c of record.cases) {
      const gdal = c.oracles.find((o) => o.id === 'gdal-hillshade')!;
      const truth = c.oracles.find((o) => o.referenceClass === 'analytic-truth')!;
      expect(Math.round(255 * truth.continuousHs!)).not.toBe(gdal.byteInterior);
    }
  });
});
