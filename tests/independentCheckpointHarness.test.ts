/**
 * independentCheckpointHarness.test.ts — the INDEPENDENT-CHECKPOINT vertical-
 * accuracy harness: pairs a point-cloud tile against USGS 3DEP survey
 * checkpoints (145,299 public-domain checkpoints, distributed as an ESRI
 * FileGDB) and reports Bias/RMSE/MAE/NMAD/P95 through the existing
 * `checkpointAccuracy()` engine — or FAILS CLOSED via
 * `checkpointPrerequisites()` (tests/support/checkpointGdb.ts) when the
 * prerequisites for an honest comparison are not met.
 *
 * ENV CONTRACT — every variable is optional; the suite `describe.skipIf`s
 * cleanly when the required three are unset, so it never runs in CI or a
 * bare checkout:
 *
 *   CHECKPOINT_SCENE            path to a LAS/LAZ tile with an official
 *                               (producer) ground classification (ASPRS
 *                               class 2). REQUIRED to run.
 *   CHECKPOINT_GDB              path to the checkpoint `.gdb` directory.
 *                               REQUIRED to run.
 *   CHECKPOINT_PROJECT_ID       the 3DEP `project_id` whose checkpoints cover
 *                               the tile's project. REQUIRED to run.
 *   CHECKPOINT_LAYER            gdb layer name. Defaults to
 *                               'Consolidated_Standardized_Checkpoints_3DEP_Version2_20250930'.
 *   CHECKPOINT_HORIZONTAL_EPSG  the tile's horizontal EPSG. Defaults to 6339
 *                               (UTM 10N), the Rogue reference tile's CRS.
 *   CHECKPOINT_VERTICAL_EPSG    the tile's vertical EPSG. Defaults to 5703
 *                               (NAVD88 height), the 3DEP checkpoint
 *                               convention; a tile in a different vertical
 *                               datum MUST set this or every checkpoint is
 *                               correctly excluded by the CRS gate.
 *
 * With all three required variables set, this test builds pathway A: an OLV
 * DTM rasterised directly from the tile's OFFICIAL class-2 ground returns
 * (no OLV ground classifier involved), sampled at each in-extent, CRS-
 * matching checkpoint's XY via OLV's own `DtmSurfaceModel` bilinear
 * interpolation (the SAME surface builder the live pipeline and the
 * hold-out validation use — see `src/terrain/validate/dtmSurfaceModel.ts`).
 * Pathway B (raw points -> OLV's own ground classifier -> OLV DTM) is not
 * exercised here; see `validation/protocols/independent-checkpoints-v1.md`.
 *
 * On the reference Rogue tile
 * (USGS_LPC_OR_RogueSiskiyouNF_2019_B19_10TDM3746.laz, project_id 182543),
 * 0 of that project's 70 checkpoints fall inside this specific tile's extent
 * — verified by direct query. That is the FAIL-CLOSED "insufficient
 * checkpoints" path, not a bug in this harness; the assertions below cover
 * both outcomes and this fixture is expected to take the closed branch.
 *
 *   CHECKPOINT_SCENE=/path/to/USGS_LPC_OR_RogueSiskiyouNF_2019_B19_10TDM3746.laz \
 *   CHECKPOINT_GDB=/path/to/Checkpoints_3DEP_2004_2025.gdb \
 *   CHECKPOINT_PROJECT_ID=182543 \
 *   npx vitest run tests/independentCheckpointHarness.test.ts
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseLasHeader } from '../src/io/lasHeader';
import { allocRawPoints, decodeContext, decodeRecord, type RawPoints } from '../src/io/lasDecodeShared';
import { decodeLaz } from '../src/io/lazDecode';
import { computeOrigin } from '../src/io/coordinateBridge';
import { DtmSurfaceModel } from '../src/terrain/validate/dtmSurfaceModel';
import { recommendGrid } from '../src/terrain/quality/recommendGrid';
import {
  readProjectCheckpointsCsv,
  runCheckpointStudy,
  MIN_CHECKPOINT_SAMPLE_SIZE,
  type TileFrame,
} from './support/checkpointGdb';

const SCENE = process.env.CHECKPOINT_SCENE;
const GDB = process.env.CHECKPOINT_GDB;
const PROJECT_ID = process.env.CHECKPOINT_PROJECT_ID;
const LAYER =
  process.env.CHECKPOINT_LAYER ?? 'Consolidated_Standardized_Checkpoints_3DEP_Version2_20250930';
const HORIZONTAL_EPSG = Number(process.env.CHECKPOINT_HORIZONTAL_EPSG ?? '6339');
const VERTICAL_EPSG = Number(process.env.CHECKPOINT_VERTICAL_EPSG ?? '5703');

const PRODUCER_GROUND = 2; // ASPRS class 2 = ground

/** Decode a plain LAS (uncompressed) or a .laz/COPC into RawPoints — same
 *  idiom as tests/groundFilterProducerAgreement.test.ts.
 *
 *  Recentring is load-bearing here. USGS 3DEP tiles carry world UTM
 *  coordinates (northings ~3.2M m Houston, ~4.65M m Rogue). Float32 ULP at
 *  those magnitudes is ~0.5 m, which would obliterate the centimetric/
 *  decimetric residuals a checkpoint study measures. The production loader
 *  (`src/io/loadLas.ts`) never lets a raw world coordinate enter Float32: it
 *  derives a per-cloud integer origin with `computeOrigin(header.min)` and
 *  subtracts it in Float64 before the f32 downcast. We do exactly the same and
 *  return the origin so callers can map checkpoints into the same local frame. */
async function decodeScene(
  path: string,
): Promise<{ out: RawPoints; count: number; origin: [number, number, number] }> {
  const bytes = readFileSync(path);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const header = parseLasHeader(buf);
  const origin = computeOrigin(header.min);
  const compressed = /\.(laz|copc\.laz)$/i.test(path);
  if (compressed) {
    const out = await decodeLaz(buf, header, origin, 1);
    return { out, count: header.pointCount, origin };
  }
  const count = header.pointCount;
  const view = new DataView(buf);
  const ctx = decodeContext(header, origin);
  const out = allocRawPoints(count, false, false);
  for (let i = 0; i < count; i++) {
    decodeRecord(view, header.offsetToPointData + i * header.pointDataRecordLength, i, ctx, out);
  }
  return { out, count, origin };
}

const ready = Boolean(SCENE && GDB && PROJECT_ID && existsSync(SCENE) && existsSync(GDB));

describe.skipIf(!ready)('independent-checkpoint accuracy harness (pathway A: producer ground -> OLV raster)', () => {
  it('reports Bias/RMSE/MAE/NMAD/P95 when prerequisites are met, else fails closed with a named reason', async () => {
    // A full USGS 3DEP tile decode + 1 m DTM rasterisation over its whole
    // extent is well beyond the default 15 s unit-test timeout.
    const { out, count, origin } = await decodeScene(SCENE!);
    const [originX, originY] = origin;

    // Bounds are accumulated in the LOCAL frame the points now live in (world
    // minus `origin`). The DTM grid and every predict() query stay local; the
    // world bounds handed to the extent/CRS gate are reconstructed by adding
    // the origin back, so the checkpoint gate still reasons in world UTM.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const trainPts: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < count; i++) {
      if (out.classification[i] !== PRODUCER_GROUND) continue;
      const x = out.positions[i * 3 + 0];
      const y = out.positions[i * 3 + 1];
      const z = out.positions[i * 3 + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      trainPts.push({ x, y, z });
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    // Sanity: the tile really does carry an official ground classification.
    expect(trainPts.length).toBeGreaterThan(0);

    // Cell size comes from the SAME production chooser the live pipeline uses
    // (`recommendGrid`, density-aware: √(area/points)·2.5 snapped to the grid
    // ladder), never a harness-local magic constant that would silently define
    // the method under test. Deterministic given the tile's extent and count.
    const cellSizeM = recommendGrid({
      pointCount: trainPts.length,
      widthM: maxX - minX,
      depthM: maxY - minY,
      reliefM: maxZ - minZ,
    }).cellSizeM;

    const grid = {
      originH1: minX,
      originH2: minY,
      cols: Math.max(1, Math.ceil((maxX - minX) / cellSizeM) + 1),
      rows: Math.max(1, Math.ceil((maxY - minY) / cellSizeM) + 1),
      cellSizeM,
    };
    const model = new DtmSurfaceModel({
      grid,
      aggregation: 'median',
      // Production parity with the shipped trusted-Class-2 ground path: despike
      // is OFF there (measured survey returns are authoritative and a steep node
      // must not be void-filled as a blunder), and the tile's vertical unit is
      // metres. Freeze both so the harness scores the surface the product ships,
      // not a despiked or rescaled variant of it.
      despike: false,
      verticalUnitToMetres: 1,
    });
    model.fit(trainPts);

    const rows = readProjectCheckpointsCsv(GDB!, LAYER, PROJECT_ID!);
    expect(rows.length).toBeGreaterThan(0); // the project itself must resolve

    const tile: TileFrame = {
      horizontalEpsg: HORIZONTAL_EPSG,
      verticalEpsg: VERTICAL_EPSG,
      minX: minX + originX,
      maxX: maxX + originX,
      minY: minY + originY,
      maxY: maxY + originY,
    };

    const measuredById = new Map<string, number>();
    for (const r of rows) {
      // World checkpoint XY → the DTM's local frame before sampling.
      const x = Number(r.source_easting) - originX;
      const y = Number(r.source_northing) - originY;
      const z = model.predict(x, y);
      if (z !== null) measuredById.set(r.unique_identifier, z);
    }

    const { prereq, result, mae } = runCheckpointStudy(rows, tile, measuredById);

    // eslint-disable-next-line no-console
    console.log(
      [
        `scene: ${SCENE!.split('/').pop()}`,
        `project ${PROJECT_ID}: ${rows.length} checkpoint(s) total`,
        `tile bounds (world): X[${tile.minX.toFixed(1)}, ${tile.maxX.toFixed(1)}]  Y[${tile.minY.toFixed(1)}, ${tile.maxY.toFixed(1)}]`,
        `local origin: [${originX}, ${originY}]  cell size: ${cellSizeM} m`,
        `prerequisites ok: ${prereq.ok}`,
        ...prereq.reasons.map((r) => `  - ${r}`),
      ].join('\n'),
    );

    if (!prereq.ok) {
      // FAIL-CLOSED path. On the reference Rogue tile this is the expected
      // outcome: 0 of the project's checkpoints fall inside this tile.
      expect(result).toBeNull();
      expect(mae).toBeNull();
      expect(prereq.reasons.length).toBeGreaterThan(0);
      expect(prereq.usable.length).toBeLessThan(MIN_CHECKPOINT_SAMPLE_SIZE);
    } else {
      expect(result?.status).toBe('reported');
      if (result?.status === 'reported') {
        // eslint-disable-next-line no-console
        console.log(
          [
            `n=${result.pooled.n}`,
            `bias=${result.pooled.bias?.toFixed(4)}`,
            `rmse=${result.pooled.rmse?.toFixed(4)}`,
            `mae=${mae?.toFixed(4)}`,
            `nmad=${result.pooled.nmad?.toFixed(4)}`,
            `p95=${result.pooled.p95AbsResidual?.toFixed(4)}`,
          ].join('  '),
        );
        expect(mae).not.toBeNull();
      }
    }
  }, 120_000);
});
