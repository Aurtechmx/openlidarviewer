import { healthCheck } from '../src/analysis/modules/healthCheck';
import { PointCloud } from '../src/model/PointCloud';

function makeCloud(positions: number[], opts?: {
  declaredPointCount?: number;
  decodedPointCount?: number;
  loadStride?: number;
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

  describe('per-cloud result memo (#5)', () => {
    test('re-running on the same cloud returns the cached result (no recompute)', () => {
      const cloud = makeCloud([0, 0, 0, 1, 1, 1, 2, 2, 2]);
      const a = healthCheck.run(cloud);
      const b = healthCheck.run(cloud);
      // Same object reference ⇒ the median-sort + dup-scan did not run again.
      expect(b).toBe(a);
    });

    test('a different cloud is not served the wrong cloud cache', () => {
      const clean = makeCloud([0, 0, 0, 5, 5, 5, 9, 9, 9]);
      const dup = makeCloud([0, 0, 0, 0, 0, 0, 1, 1, 1]);
      const cleanRes = healthCheck.run(clean);
      const dupRes = healthCheck.run(dup);
      expect(cleanRes).not.toBe(dupRes);
      expect(rowByLabel(cleanRes, 'Duplicate Points').status).toBe('pass');
      expect(rowByLabel(dupRes, 'Duplicate Points').status).toBe('warn');
    });
  });

  describe('clean cloud — all pass', () => {
    const cloud = makeCloud([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    test('invalid coordinates → pass', () => {
      expect(rowByLabel(healthCheck.run(cloud), 'Invalid Coordinates').status).toBe('pass');
    });

    test('empty cloud → pass, and the value is the VERDICT, not a point count', () => {
      const row = rowByLabel(healthCheck.run(cloud), 'Empty Cloud');
      expect(row.status).toBe('pass');
      // v0.5.5 P12 — the pass row used to print the loaded display-sample
      // count ("4,683,690 points"), mislabelling a Scan Report figure as an
      // empty-cloud value. The check is a verdict.
      expect(row.value).toBe('None');
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
    expect(row.value).toContain('0 points');
  });

  test('Empty Cloud value stays a verdict under a display-sampled load', () => {
    // A budget-capped fixture: 2 points in memory of 28,814,184 declared.
    const cloud = makeCloud([1, 2, 3, 4, 5, 6], {
      declaredPointCount: 28_814_184,
      decodedPointCount: 4_802_364,
      loadStride: 6,
    });
    const row = rowByLabel(healthCheck.run(cloud), 'Empty Cloud');
    expect(row.status).toBe('pass');
    expect(row.value).toBe('None'); // never "… points"
  });

  test('genuine mismatch on a full decode → warn with both numbers', () => {
    // The decoder read every record (no stride) and still produced fewer
    // points than the header declared — a real anomaly.
    const cloud = makeCloud([1, 2, 3, 4, 5, 6], {
      declaredPointCount: 99,
      decodedPointCount: 2,
    });
    const row = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count');
    expect(row.status).toBe('warn');
    expect(row.value).toContain('99');
    expect(row.value).toContain('2');
  });

  describe('declared vs decoded under the display-sample cap (v0.5.5 P12)', () => {
    test('decoded < declared BECAUSE of the cap → neutral info row, not amber', () => {
      // declared 28,814,184, stride 6 → the sampler keeps
      // ceil(28,814,184 / 6) = 4,802,364 records. Decode produced exactly
      // that: the shortfall is the deliberate cap, not loss.
      const cloud = makeCloud([1, 2, 3, 4, 5, 6], {
        declaredPointCount: 28_814_184,
        decodedPointCount: 4_802_364,
        loadStride: 6,
      });
      const row = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count');
      expect(row.status).toBe('info');
      expect(row.value).toContain('display sample cap');
      expect(row.value).toContain('28,814,184');
      expect(row.value).toContain('4,802,364');
    });

    test('decoded below even the capped expectation → amber (genuine loss)', () => {
      // stride 6 should keep 4,802,364 — decoding only 4,000,000 means the
      // decode lost points beyond the deliberate cap.
      const cloud = makeCloud([1, 2, 3, 4, 5, 6], {
        declaredPointCount: 28_814_184,
        decodedPointCount: 4_000_000,
        loadStride: 6,
      });
      const row = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count');
      expect(row.status).toBe('warn');
      expect(row.value).toContain('lost points');
    });

    test('declared > in-memory count with NO recorded decode count → neutral info', () => {
      // A loader that never records decodedPointCount (or an old session):
      // the in-memory count may have been voxel-reduced on purpose, so the
      // comparison cannot prove loss — the row must not raise a false alarm.
      const cloud = makeCloud([1, 2, 3, 4, 5, 6], { declaredPointCount: 99 });
      const row = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count');
      expect(row.status).toBe('info');
      expect(row.value).toContain('display sample');
      expect(row.value).toContain('99');
    });

    test('decoded ABOVE declared is still a warn even with a stride recorded as 1', () => {
      const cloud = makeCloud([1, 2, 3, 4, 5, 6], {
        declaredPointCount: 1,
        decodedPointCount: 2,
        loadStride: 1,
      });
      const row = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count');
      expect(row.status).toBe('warn');
    });
  });

  test('matching declaredPointCount → pass', () => {
    const cloud = makeCloud([1, 2, 3, 4, 5, 6], { declaredPointCount: 2 });
    const row = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count');
    expect(row.status).toBe('pass');
  });

  test('downsampled cloud — declared matches decoded → pass, not a false mismatch', () => {
    // A 3-point cloud decoded from a 100-point file, then voxel-downsampled.
    // The check compares declared vs the decoded count (100 vs 100), so it
    // passes — it must not flag the reduced point count as a mismatch.
    const cloud = makeCloud([1, 2, 3, 4, 5, 6, 7, 8, 9], {
      declaredPointCount: 100,
      decodedPointCount: 100,
    });
    const row = rowByLabel(healthCheck.run(cloud), 'Declared vs Decoded Count');
    expect(row.status).toBe('pass');
    expect(row.value).toContain('100');
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
