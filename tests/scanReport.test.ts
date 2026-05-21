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

    test('has classification row', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Classification');
      expect(row.value.toLowerCase()).toContain('yes');
      expect(row.status).toBe('info');
    });

    test('classification coverage row', () => {
      const row = rowByLabel(scanReport.run(cloud), 'Classification Coverage');
      // 3 out of 4 non-zero = 75%
      expect(parseFloat(row.value)).toBeCloseTo(75, 1);
      expect(row.status).toBe('info');
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
});
