/**
 * terrainAccessOverlayInvalidation.test.ts — tearing down the Terrain Access
 * Lab's persisted 3D overlay (traversability map + route) when its source
 * terrain goes stale, WITHOUT the Lab being reopened.
 *
 * Mirrors `flowOverlayInvalidation.test.ts` exactly: before this fix the
 * overlay was constructed fresh per mount and disposed unconditionally on
 * modal close (see `terrainAccessLab.ts`'s old `dispose: () => overlay?.dispose()`),
 * so a user who turned it on and closed the modal — which covers the scene —
 * never actually saw it, and it was never torn down by a scan close, a CRS
 * change or a classification edit while the Lab stayed closed either.
 */
import { describe, expect, it } from 'vitest';
import { acquireTerrainAccessOverlay, disposePersistentTerrainAccessOverlay } from '../src/ui/fieldSimulation/terrainAccessLab';
import { invalidateTerrainAccessOverlay } from '../src/lazyChunks';
import { buildTerrainAccessMapBuffers, terrainAccessOverlayFrame } from '../src/render/terrainAccessOverlayGeometry';
import { prepareTerrainAccessPreview } from '../src/simulation/terrainAccess/terrainAccessPreview';
import { fakeHost } from './helpers/sceneOverlayHost';
import type { HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const projected: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };

function dtmOf(rows: readonly (readonly number[])[]): DtmGrid {
  const h = rows.length, w = rows[0].length, n = w * h;
  const z = new Float32Array(n);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = rows[r][c];
  return {
    z, coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(100),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols: w, rows: h, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, withheldExcluded: true, meanConfidence: 100, warnings: [],
  } as DtmGrid;
}

const PROFILE: TerrainAccessProfile = Object.freeze({
  name: 'test',
  maxLongitudinalGrade: 10,
  maxCrossSlope: 10,
  maxStepHeight: 10,
  maxRuggedness: null,
  vehicleWidth: 0,
  vehicleLength: null,
  minimumTerrainConfidence: 0,
  unknownPolicy: 'block',
  obstacleHeightThreshold: null,
});

/** A drawn traversability map mesh on `host`, standing in for what the Lab paints. */
function paintMap(host: ReturnType<typeof fakeHost>): void {
  const dtm = dtmOf([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  const preview = prepareTerrainAccessPreview(dtm, projected, PROFILE, { interpolated: 'route', maxCells: 1_000_000, withheldExcluded: null });
  if (!preview.ok) throw new Error(`fixture preview refused: ${preview.code}`);
  const overlay = acquireTerrainAccessOverlay(host, () => false);
  if (!overlay) throw new Error('acquireTerrainAccessOverlay returned null for a real host');
  const frame = terrainAccessOverlayFrame('z', dtm.originH1, dtm.originH2, dtm.cellSizeM);
  overlay.setMap(buildTerrainAccessMapBuffers(preview.grid, preview.map, frame));
  overlay.setMapVisible(true);
}

describe('invalidateTerrainAccessOverlay tears down the persisted overlay without reopening the Lab', () => {
  it('disposes and detaches the overlay when the staleness signal fires', () => {
    const host = fakeHost();
    paintMap(host);
    expect(host.objects.length).toBeGreaterThan(0);

    // No Lab reopen, no `acquireTerrainAccessOverlay` call — this is the
    // ONLY thing that fires, exactly as `abortAndClearCache()` calls it.
    invalidateTerrainAccessOverlay();

    expect(host.objects).toHaveLength(0);
  });

  it('is a no-op when nothing is persisted (e.g. the Lab was never opened)', () => {
    disposePersistentTerrainAccessOverlay(); // start from a clean slate
    expect(() => invalidateTerrainAccessOverlay()).not.toThrow();
  });

  it('a fresh acquire after invalidation builds a NEW overlay, not the disposed one', () => {
    const host = fakeHost();
    paintMap(host);
    invalidateTerrainAccessOverlay();
    expect(host.objects).toHaveLength(0);

    // Reopening the Lab afterwards must still work: a fresh overlay, drawable.
    paintMap(host);
    expect(host.objects.length).toBeGreaterThan(0);
    disposePersistentTerrainAccessOverlay(); // leave no state for the next test file
  });
});
