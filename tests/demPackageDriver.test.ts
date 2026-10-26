/**
 * demPackageDriver.test.ts — the DEM package driver builds the whole package
 * for a committed crop, and writes the records the Python readers check.
 *
 * `npm run dem:package -- <crop> <outdir>` runs this file with
 * OLV_DEM_PACKAGE_CROP and OLV_DEM_PACKAGE_OUT set, because the builders are
 * TypeScript the Node entry point cannot import on its own. Without them the
 * file builds the smallest committed crop into a temporary directory, so the
 * driver is exercised on every test run. The Python readers are not run here:
 * the gate executes no Python; the entry point runs them after this file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCropDemPackage, returnsPerCell, SMALLEST_CROP, CROPS } from './support/demPackageDriver';
import { sha256Hex } from '../src/terrain/export/sha256';
import { hasStreamLab, streamLabGround } from './support/terrainField';
import { computeTerrainCore } from '../src/terrain/contour/analyseContours';
import { ASPRS_GROUND_CLASS } from '../src/terrain/ground/liveDtmConstants';

const requested = process.env.OLV_DEM_PACKAGE_CROP;
const requestedOut = process.env.OLV_DEM_PACKAGE_OUT;
const cropId = requested ?? SMALLEST_CROP;
const present = CROPS.find((c) => c.cropId === cropId)?.present() ?? false;

describe.skipIf(!present)(`dem:package on ${cropId}`, () => {
  const outDir = requestedOut ?? mkdtempSync(join(tmpdir(), 'olv-dem-package-'));
  const cleanup = requestedOut === undefined;

  it('writes the package, its entries and the three reader records', async () => {
    const r = await buildCropDemPackage(cropId, outDir);
    try {
      expect(r.groundPoints).toBeGreaterThan(0);
      expect(existsSync(r.zipPath)).toBe(true);
      for (const name of [
        `${cropId}-dtm.tif`, `${cropId}_evidence.tif`, `${cropId}_sensitivity.tif`, `${cropId}_attention.tif`,
        `${cropId}_evidence.qml`, `${cropId}_attention.qml`, `${cropId}_attention-reason.qml`,
        `${cropId}_sensitivity.qml`, `${cropId}_sensitivity-members.qml`,
        `${cropId}-README.txt`, 'SHA256SUMS.txt',
      ]) {
        expect(r.entries, name).toContain(name);
        expect(existsSync(join(outDir, 'package', name)), name).toBe(true);
      }
      // Each reader record names the digest of the raster beside it.
      for (const [dir, tif] of [
        [r.oracleDirs['terrain-evidence'], 'terrain_evidence.tif'],
        [r.oracleDirs['terrain-attention'], 'terrain_attention.tif'],
        [r.oracleDirs['terrain-sensitivity'], 'terrain_sensitivity.tif'],
      ] as const) {
        const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { sha256: string; cols: number; rows: number };
        expect(expected.sha256).toBe(sha256Hex(new Uint8Array(readFileSync(join(dir, tif)))));
        expect(expected.cols * expected.rows).toBe(r.cols * r.rows);
      }
      if (requestedOut) console.log(`dem:package wrote ${r.zipPath} (${r.cols} x ${r.rows} cells from ${r.groundPoints} ground returns)`);
    } finally {
      if (cleanup) rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!hasStreamLab())('bins the returns per cell exactly as the rasteriser counted them', () => {
    // The evidence reader checks each cell's return list against support_count,
    // so the driver's binning rule has to be the rasteriser's own.
    const points = streamLabGround();
    const core = computeTerrainCore(points, {
      cellSizeM: 1,
      classification: new Uint8Array(points.length).fill(ASPRS_GROUND_CLASS),
      trustGroundClassification: true,
    });
    const lists = returnsPerCell(points, core.dtm);
    expect(lists.map((l) => l.length)).toEqual(Array.from(core.dtm.counts));
  });
});
