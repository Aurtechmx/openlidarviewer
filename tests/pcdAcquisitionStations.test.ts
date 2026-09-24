/**
 * pcdAcquisitionStations.test.ts — the AcquisitionStations sidecar (OB-INT-02)
 * for PCD, and the "no station" case for a format that never carries one.
 *
 * SPEC §1.3: organized PCD gets a station only when the header declares a
 * viewpoint; unorganized PCD never does, regardless of a viewpoint line
 * (there is no per-scan or per-block boundary to name); LAS/LAZ never
 * declares an origin at all, so it never gets a sidecar (`acquisitionStations`
 * stays `undefined`) — the "non-station load" OB-INT-02 approval names.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { loadPcd } from '../src/io/loadPcd';
import { loadLas } from '../src/io/loadLas';

interface HeaderOptions {
  readonly width: number;
  readonly height: number;
  readonly points?: number;
  readonly viewpoint?: string | null;
}

/** An ascii PCD with x y z fields, the same builder pcdOrganizedRange.test.ts uses. */
function asciiPcd(options: HeaderOptions, rows: readonly string[]): ArrayBuffer {
  const { width, height, points = width * height, viewpoint = '0 0 0 1 0 0 0' } = options;
  const lines = [
    '# .PCD v0.7',
    'VERSION 0.7',
    'FIELDS x y z',
    'SIZE 8 8 8',
    'TYPE F F F',
    'COUNT 1 1 1',
    `WIDTH ${width}`,
    `HEIGHT ${height}`,
    ...(viewpoint === null ? [] : [`VIEWPOINT ${viewpoint}`]),
    `POINTS ${points}`,
    'DATA ascii',
    ...rows,
    '',
  ];
  return new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
}

const GRID_ROWS: string[] = [];
for (let row = 0; row < 3; row++) {
  for (let column = 0; column < 4; column++) {
    GRID_ROWS.push(`${column} ${row} 0`);
  }
}

describe('an organized PCD with a declared viewpoint', () => {
  it('records one station covering the whole cloud, byte-identical positions', async () => {
    const pc = await loadPcd(asciiPcd({ width: 4, height: 3 }, GRID_ROWS));
    expect(pc.pointCount).toBe(12);
    const stations = pc.acquisitionStations?.stations;
    expect(stations).toHaveLength(1);
    expect(stations![0]).toMatchObject({
      id: 'pcd-viewpoint',
      source: 'pcd-viewpoint',
      originStatus: 'DECLARED',
      recordRange: { start: 0, end: 12 },
    });
    expect(stations![0].pose.worldTranslation).toEqual([0, 0, 0]);
    // Unchanged from what pcdOrganizedRange.test.ts already pins for this
    // fixture: the grid and the raw coordinates.
    expect(pc.organizedRange?.frames).toHaveLength(1);
  });

  it('shrinks the station when sanitation drops a record', async () => {
    const rowsWithOneNaN = [...GRID_ROWS];
    rowsWithOneNaN[5] = 'nan nan nan'; // one of the 12 cells, mid-grid
    const pc = await loadPcd(asciiPcd({ width: 4, height: 3 }, rowsWithOneNaN));
    expect(pc.pointCount).toBe(11);
    const stations = pc.acquisitionStations!.stations;
    expect(stations).toHaveLength(1);
    expect(stations[0].recordRange).toEqual({ start: 0, end: 11 });
  });
});

describe('an organized PCD with NO declared viewpoint', () => {
  it('carries the grid but no station', async () => {
    const pc = await loadPcd(asciiPcd({ width: 4, height: 3, viewpoint: null }, GRID_ROWS));
    expect(pc.organizedRange?.frames).toHaveLength(1); // the grid does not need a viewpoint
    expect(pc.acquisitionStations).toBeUndefined();
  });
});

describe('an unorganized PCD, even with a declared viewpoint', () => {
  it('carries no station — there is no per-scan boundary to name', async () => {
    const pc = await loadPcd(asciiPcd({ width: 3, height: 1 }, ['0 0 0', '1 0 0', '2 0 0']));
    expect(pc.organizedRange).toBeUndefined();
    expect(pc.acquisitionStations).toBeUndefined();
  });
});

describe('a format with no declared origin at all (non-station load)', () => {
  it('LAS never carries the sidecar, and every other field is unaffected', async () => {
    const file = readFileSync(fileURLToPath(new URL('./fixtures/tiny.las', import.meta.url)));
    const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    const pc = await loadLas(buffer, 'las', 'tiny.las');
    // Unchanged from tests/loadLas.test.ts's own assertions of this fixture.
    expect(pc.pointCount).toBe(12);
    expect(pc.origin).toEqual([500123, 4100876, 210]);
    expect(pc.acquisitionStations).toBeUndefined();
  });
});
