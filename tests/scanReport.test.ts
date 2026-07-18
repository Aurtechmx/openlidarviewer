import { scanReport } from '../src/analysis/modules/scanReport';
import { PointCloud } from '../src/model/PointCloud';

function rowByLabel(result: ReturnType<typeof scanReport.run>, label: string) {
  const row = result.rows.find(r => r.label === label);
  if (!row) throw new Error(`Row "${label}" not found. Rows: ${result.rows.map(r => r.label).join(', ')}`);
  return row;
}

describe('scanReport module', () => {
  test('id and label', () => {
    expect(scanReport.id).toBe('scan-report');
    expect(scanReport.label).toBe('Scan Report');
  });

  describe('known point cloud', () => {
    // 4 points forming a 2×2 XY footprint, z from 0 to 1
    // (0,0,0), (2,0,0), (0,2,0), (2,2,1)
    // pointCount = 4
    // bounds: min=[0,0,0], max=[2,2,1]
    // width=2, depth=2, height=1
    // footprintArea = 2*2 = 4
    // density = 4/4 = 1.0 pts/m²
    // spacing = sqrt(4/4) = 1.0 m
    const positions = new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
      2, 2, 1,
    ]);
    const colors = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128]);
    const intensity = new Uint16Array([100, 200, 300, 400]);
    const classification = new Uint8Array([1, 2, 0, 5]); // 3 out of 4 non-zero = 75%

    const cloud = new PointCloud({
      positions,
      colors,
      intensity,
      classification,
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'test-scan',
    });

    test('point count row', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Point Count');
      expect(row.value).toContain('4');
      expect(row.status).toBe('info');
    });

    test('extent rows', () => {
      const result = scanReport.run(cloud);
      const widthRow = rowByLabel(result, 'Width');
      const depthRow = rowByLabel(result, 'Depth');
      const heightRow = rowByLabel(result, 'Height');
      expect(parseFloat(widthRow.value)).toBeCloseTo(2, 3);
      expect(parseFloat(depthRow.value)).toBeCloseTo(2, 3);
      expect(parseFloat(heightRow.value)).toBeCloseTo(1, 3);
    });

    test('point density row', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Density');
      // density = 4/(2*2) = 1.0 pts/m²
      expect(parseFloat(row.value)).toBeCloseTo(1.0, 3);
      expect(row.status).toBe('info');
    });

    test('estimated point spacing row', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Spacing');
      // spacing = sqrt(4/4) = 1.0
      expect(parseFloat(row.value)).toBeCloseTo(1.0, 3);
      expect(row.status).toBe('info');
    });

    test('has RGB row', () => {
      const row = rowByLabel(scanReport.run(cloud), 'RGB');
      expect(row.value.toLowerCase()).toContain('yes');
      expect(row.status).toBe('info');
    });

    test('has intensity row', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Intensity');
      expect(row.value.toLowerCase()).toContain('yes');
      expect(row.status).toBe('info');
    });

    test('has classification row with merged coverage (v0.5.5 P12)', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Classification');
      expect(row.value.toLowerCase()).toContain('yes');
      // 3 out of 4 non-zero = 75% — merged into the same row, not a
      // separate "Classification Coverage" diagnostic.
      expect(row.value).toContain('75.0 % coverage');
      expect(row.status).toBe('info');
    });

    test('no separate Classification Coverage row remains', () => {
      expect(
        scanReport.run(cloud).rows.find((r) => r.label === 'Classification Coverage'),
      ).toBeUndefined();
    });
  });

  describe('Y-up mesh formats measure footprint/height on the right axes', () => {
    // A façade-style PLY: tall in Y (20 m), 10 m × 4 m on the ground. PLY/OBJ/
    // GLB load Y-up, so height = Y-span and the ground footprint is X·Z. Treating
    // it Z-up put the 20 m height into "Depth" and computed density over the
    // vertical cross-section (X·Y = 200 m²) instead of the footprint (40 m²).
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 4]),
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'facade',
    });
    test('Height is the Y-span (20 m), not the Z-span', () => {
      expect(parseFloat(rowByLabel(scanReport.run(cloud), 'Height').value)).toBeCloseTo(20, 3);
    });
    test('Width/Depth are the horizontal X and Z spans', () => {
      expect(parseFloat(rowByLabel(scanReport.run(cloud), 'Width').value)).toBeCloseTo(10, 3);
      expect(parseFloat(rowByLabel(scanReport.run(cloud), 'Depth').value)).toBeCloseTo(4, 3);
    });
    test('Density is over the ground footprint X·Z (4/40), not X·Y', () => {
      expect(parseFloat(rowByLabel(scanReport.run(cloud), 'Density').value)).toBeCloseTo(0.1, 4);
    });
  });

  describe('strided (display-sampled) cloud reports the FILE, not the subset', () => {
    // 4 points loaded for display, but the file declared 40 — the loader strided
    // it 10×. The report must headline the file's count and density, disclose the
    // loaded subset, and NOT under-report a dense survey as sparse.
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'laz',
      name: 'strided',
      declaredPointCount: 40,
    });

    test('Point Count is the declared file total', () => {
      expect(rowByLabel(scanReport.run(cloud), 'Point Count').value).toContain('40');
    });

    test('a Loaded row discloses the display sample', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Loaded');
      expect(row.value).toContain('4');
      expect(row.value.toLowerCase()).toContain('display sample');
    });

    test('Density is back-scaled to the file (40/4 = 10), not the sample (1.0)', () => {
      expect(parseFloat(rowByLabel(scanReport.run(cloud), 'Density').value)).toBeCloseTo(10.0, 3);
    });

    test('a non-strided cloud (no declared total) adds no Loaded row', () => {
      const plain = new PointCloud({
        positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 1]),
        origin: [0, 0, 0],
        sourceFormat: 'las',
        name: 'plain',
      });
      expect(scanReport.run(plain).rows.find((r) => r.label === 'Loaded')).toBeUndefined();
    });
  });

  describe('classification dimension present but fully unassigned', () => {
    // Every point class 0/1 (never classified / unclassified) — the field exists,
    // but nothing is classified. "Yes" would overclaim; report the honest state.
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1]),
      classification: new Uint8Array([0, 0, 1, 0]),
      origin: [0, 0, 0],
      sourceFormat: 'laz',
      name: 'unclassified',
    });

    test('Classification → "Present, unclassified" with its coverage inline', () => {
      // 1 of 4 points carries a non-zero code (class 1 = unclassified), so
      // coverage reads 25.0 % while assignment honestly stays "unclassified".
      expect(rowByLabel(scanReport.run(cloud), 'Classification').value).toBe(
        'Present, unclassified (25.0 % coverage)',
      );
    });
  });

  describe('cloud without optional attributes', () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'minimal',
    });

    test('has RGB → no', () => {
      const row = rowByLabel(scanReport.run(cloud), 'RGB');
      expect(row.value.toLowerCase()).toContain('no');
    });

    test('has intensity → no', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Intensity');
      expect(row.value.toLowerCase()).toContain('no');
    });

    test('has classification → no', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Classification');
      expect(row.value.toLowerCase()).toContain('no');
    });
  });

  describe('degenerate cloud (all same XY)', () => {
    // All points at same XY → footprintArea = 0
    const cloud = new PointCloud({
      positions: new Float32Array([1, 1, 0, 1, 1, 1, 1, 1, 2]),
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'degenerate',
    });

    test('density → warn or info on zero-area footprint', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Density');
      expect(['warn', 'info']).toContain(row.status);
    });

    test('spacing → warn or info on zero-area footprint', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Spacing');
      expect(['warn', 'info']).toContain(row.status);
    });
  });

  describe('foot-CRS extent + density convert native units to metres (#2)', () => {
    // 4 points spanning 2×2×1 in the source unit. With a foot CRS the report
    // must read those spans as metres (×0.3048), so density / spacing come out
    // in true pts/m² and m — not the ~10.76× understated pts/ft² they were.
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'sp-feet',
      metadata: {
        crs: {
          source: 'wkt',
          name: 'NAD83 / State Plane (ftUS)',
          linearUnit: 'foot',
          linearUnitToMetres: 0.3048,
          isGeographic: false,
        },
      },
    });

    test('extent rows convert feet → metres (rounded to a tenth of a metre)', () => {
      const r = scanReport.run(cloud);
      // 2 ft → 0.6096 m → "0.6 m"; 1 ft → 0.3048 m → "0.3 m".
      expect(parseFloat(rowByLabel(r, 'Width').value)).toBeCloseTo(0.6, 1);
      expect(parseFloat(rowByLabel(r, 'Depth').value)).toBeCloseTo(0.6, 1);
      expect(parseFloat(rowByLabel(r, 'Height').value)).toBeCloseTo(0.3, 1);
    });

    test('density is pts per true m² (not pts/ft² mislabelled)', () => {
      // 4 pts / (0.6096 m)² ≈ 10.76 pts/m².
      expect(parseFloat(rowByLabel(scanReport.run(cloud), 'Density').value)).toBeCloseTo(10.76, 1);
    });

    test('spacing reads in metres (sub-metre ⇒ cm), not the unconverted 1.0 m', () => {
      // sqrt(0.6096² / 4) = 0.3048 m → formatted "30.5 cm". The buggy native
      // path gave sqrt(4/4) = 1.0 m, so the cm unit alone proves the conversion.
      const v = rowByLabel(scanReport.run(cloud), 'Spacing').value;
      expect(v).toMatch(/cm/);
      expect(parseFloat(v)).toBeCloseTo(30.5, 0);
    });
  });
});
