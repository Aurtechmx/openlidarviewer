import { healthCheck } from '../src/analysis/modules/healthCheck';
import { PointCloud } from '../src/model/PointCloud';

function makeCloud(positions: number[], opts?: {
  declaredPointCount?: number;
  classification?: Uint8Array;
}): PointCloud {
  return new PointCloud({
    positions: new Float32Array(positions),
    origin: [0, 0, 0],
    sourceFormat: 'ply',
    name: 'test',
    ...opts,
  });
}

function rowByLabel(result: ReturnType<typeof healthCheck.run>, label: string) {
  const row = result.rows.find(r => r.label === label);
  if (!row) throw new Error(`Row "${label}" not found. Rows: ${result.rows.map(r => r.label).join(', ')}`);
  return row;
}

describe('healthCheck module', () => {
  test('id and label', () => {
    expect(healthCheck.id).toBe('health-check');
    expect(healthCheck.label).toBe('Health Check');
  });

  describe('clean cloud — all pass', () => {
    const cloud = makeCloud([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    test('invalid coordinates → pass', () => {
      expect(rowByLabel(healthCheck.run(cloud), 'Invalid Coordinates').status).toBe('pass');
    });

    test('empty cloud → pass', () => {
      expect(rowByLabel(healthCheck.run(cloud), 'Empty Cloud').status).toBe('pass');
    });

    test('declared vs decoded count → pass or info when no declaredPointCount', () => {
      const status = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count').status;
      expect(['pass', 'info']).toContain(status);
    });

    test('duplicate points → pass', () => {
      expect(rowByLabel(healthCheck.run(cloud), 'Duplicate Points').status).toBe('pass');
    });

    test('stray outliers → pass', () => {
      expect(rowByLabel(healthCheck.run(cloud), 'Stray Outliers').status).toBe('pass');
    });
  });

  test('NaN coordinate → invalid coordinates fail', () => {
    const cloud = makeCloud([1, NaN, 3, 4, 5, 6]);
    const row = rowByLabel(healthCheck.run(cloud), 'Invalid Coordinates');
    expect(row.status).toBe('fail');
    expect(row.value).toContain('1');
  });

  test('Infinite coordinate → invalid coordinates fail', () => {
    const cloud = makeCloud([Infinity, 2, 3, 4, 5, 6]);
    const row = rowByLabel(healthCheck.run(cloud), 'Invalid Coordinates');
    expect(row.status).toBe('fail');
  });

  test('empty cloud → empty cloud fail', () => {
    const cloud = makeCloud([]);
    const row = rowByLabel(healthCheck.run(cloud), 'Empty Cloud');
    expect(row.status).toBe('fail');
  });

  test('mismatched declaredPointCount → warn with both numbers', () => {
    const cloud = makeCloud([1, 2, 3, 4, 5, 6], { declaredPointCount: 99 });
    const row = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count');
    expect(row.status).toBe('warn');
    expect(row.value).toContain('99');
    expect(row.value).toContain('2');
  });

  test('matching declaredPointCount → pass', () => {
    const cloud = makeCloud([1, 2, 3, 4, 5, 6], { declaredPointCount: 2 });
    const row = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count');
    expect(row.status).toBe('pass');
  });

  test('duplicate points → warn with correct count', () => {
    // 3 unique + 2 duplicates = 5 points total, 2 duplicates
    const cloud = makeCloud([
      1, 2, 3,
      1, 2, 3, // duplicate of first
      4, 5, 6,
      4, 5, 6, // duplicate of third
      7, 8, 9,
    ]);
    const row = rowByLabel(healthCheck.run(cloud), 'Duplicate Points');
    expect(row.status).toBe('warn');
    expect(row.value).toContain('2');
  });

  test('no duplicates → pass', () => {
    const cloud = makeCloud([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const row = rowByLabel(healthCheck.run(cloud), 'Duplicate Points');
    expect(row.status).toBe('pass');
  });

  test('stray outlier → warn with count', () => {
    // A tight cluster at 0 with one extreme outlier
    const positions: number[] = [];
    for (let i = 0; i < 20; i++) {
      positions.push(i * 0.1, i * 0.1, i * 0.1);
    }
    // Add a massive outlier
    positions.push(10000, 10000, 10000);
    const cloud = makeCloud(positions);
    const row = rowByLabel(healthCheck.run(cloud), 'Stray Outliers');
    expect(row.status).toBe('warn');
    expect(row.value).toContain('1');
  });
});
