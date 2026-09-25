import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildF1Scene, buildF8Cases, type ObservatoryF8Case } from '../scripts/generate-observatory-fixtures.mjs';
import { F8_EXPECTED_PATH, type F8ExpectedRecord } from './helpers/observatoryFixtures';

/**
 * F8 (SPEC §9.1, O1's exit evidence): the DDA cases' traversal lists are
 * frozen by validation/observatory/oracle/ray_aabb_traversal.py, an
 * independent Python restatement — the actual TypeScript DDA is O4, so this
 * phase checks something narrower and prior to it: that the fixture
 * generator's inputs and the frozen records agree on what was traversed, so
 * O4 inherits fixtures and expectations that cannot have silently drifted
 * apart from each other.
 */

const ROOT = join(__dirname, '..');
const F8_FIXTURE_PATH = join(ROOT, 'validation', 'observatory', 'fixtures', 'f8-dda-cases.json');
const F1_FIXTURE_PATH = join(ROOT, 'validation', 'observatory', 'fixtures', 'f1-wall-room.json');

describe('F8 — fixture generator matches the committed fixture (no drift)', () => {
  it('buildF8Cases() reproduces validation/observatory/fixtures/f8-dda-cases.json exactly', () => {
    const committed = JSON.parse(readFileSync(F8_FIXTURE_PATH, 'utf8'));
    expect(buildF8Cases()).toEqual(committed);
  });

  it('buildF1Scene() reproduces validation/observatory/fixtures/f1-wall-room.json exactly', () => {
    const committed = JSON.parse(readFileSync(F1_FIXTURE_PATH, 'utf8'));
    expect(buildF1Scene()).toEqual(committed);
  });
});

describe('F8 — the frozen Python-oracle records are consistent with the fixture (OB-LED-01)', () => {
  const fixture = buildF8Cases();
  const expected = JSON.parse(readFileSync(F8_EXPECTED_PATH, 'utf8')) as { cases: F8ExpectedRecord[] };

  it('every fixture case has exactly one frozen record, and vice versa', () => {
    const fixtureIds = fixture.cases.map((c: ObservatoryF8Case) => c.id).sort();
    const expectedIds = expected.cases.map((c) => c.caseId).sort();
    expect(expectedIds).toEqual(fixtureIds);
  });

  it.each(fixture.cases)('$id: the frozen record\'s input echoes the fixture\'s own fields exactly', (fixtureCase: ObservatoryF8Case) => {
    const record = expected.cases.find((c) => c.caseId === fixtureCase.id);
    expect(record).toBeDefined();
    expect(record!.input.origin).toEqual(fixtureCase.origin);
    expect(record!.input.direction).toEqual(fixtureCase.direction);
    expect(record!.input.tMax).toEqual(fixtureCase.tMax);
    expect(record!.input.domain).toEqual(fixture.domain);
    expect(record!.input.voxelEdge).toEqual(fixture.voxelEdge);
  });

  it('every traversed voxel lies inside the declared domain, at integer indices', () => {
    const cellsPerAxis = [0, 1, 2].map(
      (a) => (fixture.domain.maxCorner[a] - fixture.domain.minCorner[a]) / fixture.voxelEdge,
    );
    for (const record of expected.cases) {
      for (const voxel of record.voxels) {
        expect(voxel).toHaveLength(3);
        for (let a = 0; a < 3; a++) {
          expect(Number.isInteger(voxel[a]), `${record.caseId} voxel ${JSON.stringify(voxel)} axis ${a}`).toBe(true);
          expect(voxel[a] >= 0 && voxel[a] < cellsPerAxis[a], `${record.caseId} voxel ${JSON.stringify(voxel)} axis ${a} outside domain`).toBe(true);
        }
      }
    }
  });

  it('the zero-length case traverses exactly one voxel', () => {
    const record = expected.cases.find((c) => c.caseId === 'F8-zero-length');
    expect(record?.voxels).toHaveLength(1);
  });

  it('the along-face and axis-aligned cases both resolve to the SAME voxel row (the written tie rule applied at a boundary)', () => {
    const axisAligned = expected.cases.find((c) => c.caseId === 'F8-axis-aligned');
    const alongFace = expected.cases.find((c) => c.caseId === 'F8-along-face');
    expect(axisAligned?.voxels).toEqual(alongFace?.voxels);
  });

  it('the grazing-corner case advances two axes together per step (one new voxel per shared corner, not two)', () => {
    const record = expected.cases.find((c) => c.caseId === 'F8-grazing-corner');
    expect(record?.voxels).toEqual([
      [0, 0, 0],
      [1, 1, 0],
      [2, 2, 0],
    ]);
  });
});
