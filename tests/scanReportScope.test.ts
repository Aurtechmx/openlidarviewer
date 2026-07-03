/**
 * tests/scanReportScope.test.ts
 *
 * Coverage for the class-scope-aware Scan Report. Two non-negotiables:
 *
 *  1. FULL / ABSENT scope must be byte-identical to the legacy result — an
 *     unfiltered user sees ZERO change, and no row carries a scope stamp.
 *  2. A SUBSET scope restricts the per-point figures (count, footprint,
 *     density, coverage) to the visible classes and stamps `row.scope` on
 *     every affected row.
 */

import { describe, it, expect } from 'vitest';
import { scanReport } from '../src/analysis/modules/scanReport';
import { PointCloud } from '../src/model/PointCloud';
import { fullScope, scopeFrom } from '../src/render/class/classScope';
import { classificationLabel } from '../src/render/pointInfo';

// 4 points, two classes:
//   ground (2): (0,0,0), (2,0,0)
//   building (6): (0,2,0), (2,2,1)
// Full footprint: 2×2 = 4, density 4/4 = 1.0, coverage 4/4 non-zero = 100%.
function makeCloud(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
      2, 2, 1,
    ]),
    classification: new Uint8Array([2, 2, 6, 6]),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'scope-fixture',
  });
}

const nameOf = (c: number): string => classificationLabel(c);

function rowByLabel(result: ReturnType<typeof scanReport.run>, label: string) {
  const row = result.rows.find((r) => r.label === label);
  if (!row) throw new Error(`Row "${label}" not found`);
  return row;
}

describe('scanReport — full/absent scope is byte-identical to legacy', () => {
  it('absent scope === full scope === legacy, with no row stamps', () => {
    const cloud = makeCloud();
    const legacy = scanReport.run(cloud);
    const withFull = scanReport.run(cloud, undefined, { scope: fullScope() });

    // Serialising both results captures value, status, advanced AND the
    // absence of any `scope` key — a byte-for-byte equality guard.
    expect(JSON.stringify(withFull)).toBe(JSON.stringify(legacy));

    // No legacy row carries a scope stamp.
    for (const row of legacy.rows) expect(row.scope).toBeUndefined();
    expect(legacy.scope).toBeUndefined();
  });
});

describe('scanReport — subset scope restricts and stamps', () => {
  it('ground-only subset changes count/density/coverage and stamps affected rows', () => {
    const cloud = makeCloud();
    const scope = scopeFrom([2], [2, 6], nameOf); // show ground, hide building
    expect(scope.kind).toBe('subset');

    const result = scanReport.run(cloud, undefined, { scope });

    // Two ground points, footprint shrinks to the ground extent: x 0..2, y 0.
    const count = rowByLabel(result, 'Point Count');
    expect(count.value).toContain('2');
    expect(count.scope).toEqual(scope);

    // Ground points share y=0 → degenerate footprint → density N/A.
    const density = rowByLabel(result, 'Density');
    expect(density.value).toContain('N/A');
    expect(density.scope).toEqual(scope);

    // Coverage: both visible points are class 2 (non-zero) → 100% of 2.
    // v0.5.5 P12 — coverage merged into the Classification row.
    const classification = rowByLabel(result, 'Classification');
    expect(classification.value).toContain('100.0 % coverage');
    expect(classification.scope).toEqual(scope);

    // Result-level scope is carried too.
    expect(result.scope).toEqual(scope);
  });

  it('building-only subset yields a non-degenerate, distinct density', () => {
    const cloud = makeCloud();
    const scope = scopeFrom([6], [2, 6], nameOf); // show building, hide ground
    const result = scanReport.run(cloud, undefined, { scope });

    // Building points: (0,2,0),(2,2,1) → width 2, depth 0 → still degenerate.
    // Use a richer fixture for a real density change instead.
    const richer = new PointCloud({
      positions: new Float32Array([
        0, 0, 0,
        4, 0, 0,
        0, 4, 0, // ground spans 4×4
        1, 1, 5,
        3, 3, 6, // building spans 2×2
      ]),
      classification: new Uint8Array([2, 2, 2, 6, 6]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'richer',
    });
    const buildingScope = scopeFrom([6], [2, 6], nameOf);
    const r = scanReport.run(richer, undefined, { scope: buildingScope });
    const d = rowByLabel(r, 'Density');
    // 2 building points over a 2×2 = 4 footprint → 0.5 pts/m².
    expect(parseFloat(d.value)).toBeCloseTo(0.5, 3);
    expect(d.scope).toEqual(buildingScope);

    // And the count row reflects the building subset.
    expect(rowByLabel(result, 'Point Count').value).toContain('2');
  });

  it('empty subset (no visible points) reports N/A density without crashing', () => {
    const cloud = makeCloud();
    // A class not present in the cloud → scopeFrom intersects to empty subset.
    const scope = scopeFrom([99], [2, 6], nameOf);
    expect(scope.kind).toBe('subset');
    const result = scanReport.run(cloud, undefined, { scope });
    expect(rowByLabel(result, 'Point Count').value).toContain('0');
    expect(rowByLabel(result, 'Density').value).toContain('N/A');
    // v0.5.5 P12 — with no visible points there is no coverage figure to
    // append; the merged Classification row reports presence only.
    expect(rowByLabel(result, 'Classification').value).not.toContain('coverage');
  });
});
