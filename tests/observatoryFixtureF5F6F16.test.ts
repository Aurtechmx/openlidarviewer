/**
 * observatoryFixtureF5F6F16.test.ts — F5, F6, F16 ray-level (SPEC §9.1, O3's
 * exit evidence). Mirrors observatoryFixtureF8.test.ts's drift-check pattern:
 * the generator's output must match the committed fixture exactly, and this
 * file's own ray-level assertions build an actual OrganizedRangeFrame from
 * that committed scene and run it through the ray builder.
 *
 * "generator-truth", not an independent oracle (validation/observatory/README.md):
 * the ray-kind-per-cell-state mapping under test is a direct, closed-form
 * transcription of OB-RAY-01's own stated rule table, not a numeric algorithm.
 * F1 itself carries no oracle-registry entry for the same reason, and this
 * file follows that precedent rather than adding one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildF5Scene, buildF6Scene, buildF16Scene } from '../scripts/generate-observatory-fixtures.mjs';
import {
  CellState,
  NO_RECORD,
  buildCellReturns,
  cellIndexOf,
  tallyCellStates,
  type CellReturnInput,
  type OrganizedRangeFrame,
} from '../src/model/OrganizedRange';
import type { AcquisitionStation } from '../src/model/AcquisitionStations';
import { buildGriddedSourceRays, type GriddedRayCoverage } from '../src/observation/rays';

const ROOT = join(__dirname, '..');
const FIXTURES = join(ROOT, 'validation', 'observatory', 'fixtures');

interface SceneStation {
  readonly id: string;
  readonly origin: readonly [number, number, number];
}
interface SceneCoverage {
  readonly azimuth0: number;
  readonly azimuthStep: number;
  readonly polar0: number;
  readonly polarStep: number;
}
interface F5Scene {
  readonly width: number;
  readonly height: number;
  readonly station: SceneStation;
  readonly coverage: SceneCoverage;
  readonly noReturnCells: readonly (readonly [number, number])[];
}
interface F6Scene {
  readonly width: number;
  readonly height: number;
  readonly station: SceneStation;
  readonly coverage: SceneCoverage;
  readonly stride: number;
}
interface F16SceneReturn {
  readonly returnIndex: number;
  readonly range: number;
}
interface F16SceneCell {
  readonly row: number;
  readonly column: number;
  readonly returns: readonly F16SceneReturn[];
}
interface F16Scene {
  readonly width: number;
  readonly height: number;
  readonly station: SceneStation;
  readonly coverage: SceneCoverage;
  readonly cells: readonly F16SceneCell[];
}

function stationFrom(scene: SceneStation, source: AcquisitionStation['source'], recordCount: number): AcquisitionStation {
  return {
    id: scene.id,
    source,
    pose: { worldTranslation: scene.origin, localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: recordCount },
    originStatus: 'DECLARED',
  };
}

function coverageFrom(scene: SceneCoverage): GriddedRayCoverage {
  return { azimuth0: scene.azimuth0, azimuthStep: scene.azimuthStep, polar0: scene.polar0, polarStep: scene.polarStep };
}

describe('F5 — fixture generator matches the committed fixture (no drift)', () => {
  it('buildF5Scene() reproduces validation/observatory/fixtures/f5-sky-noreturn.json exactly', () => {
    const committed = JSON.parse(readFileSync(join(FIXTURES, 'f5-sky-noreturn.json'), 'utf8'));
    expect(buildF5Scene()).toEqual(committed);
  });
});

describe('F6 — fixture generator matches the committed fixture (no drift)', () => {
  it('buildF6Scene() reproduces validation/observatory/fixtures/f6-strided-notread.json exactly', () => {
    const committed = JSON.parse(readFileSync(join(FIXTURES, 'f6-strided-notread.json'), 'utf8'));
    expect(buildF6Scene()).toEqual(committed);
  });
});

describe('F16 — fixture generator matches the committed fixture (no drift)', () => {
  it('buildF16Scene() reproduces validation/observatory/fixtures/f16-multireturn-canopy.json exactly', () => {
    const committed = JSON.parse(readFileSync(join(FIXTURES, 'f16-multireturn-canopy.json'), 'utf8'));
    expect(buildF16Scene()).toEqual(committed);
  });
});

describe('F5 (ray-level): a PTX 0 0 0 sky cell produces a no-return ray, never a no-ray and never NOT_READ', () => {
  const scene = buildF5Scene() as F5Scene;
  const noReturn = new Set(scene.noReturnCells.map(([r, c]) => `${r},${c}`));
  const cells = scene.width * scene.height;
  const cellState = new Uint8Array(cells).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(cells).fill(NO_RECORD);
  const geometricRange = new Float32Array(cells).fill(Number.NaN);
  let record = 0;
  for (let row = 0; row < scene.height; row++) {
    for (let column = 0; column < scene.width; column++) {
      const idx = cellIndexOf(row, column, scene.width);
      if (noReturn.has(`${row},${column}`)) {
        cellState[idx] = CellState.NO_RETURN;
        continue;
      }
      cellToRecord[idx] = record++;
      geometricRange[idx] = 10; // arbitrary finite declared range; not under test here
    }
  }
  const frame: OrganizedRangeFrame = {
    id: scene.station.id,
    sourceKind: 'ptx-grid',
    width: scene.width,
    height: scene.height,
    cellState,
    cellToRecord,
    geometricRange,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
  const build = buildGriddedSourceRays(
    frame,
    stationFrom(scene.station, 'ptx-block', record),
    0,
    coverageFrom(scene.coverage),
    { kind: 'none' },
  );

  it('every sky cell lands in returnedChunks with NaN range and a finite direction', () => {
    expect(frame.diagnostics.stateCounts[CellState.NO_RETURN]).toBe(scene.noReturnCells.length);
    let seen = 0;
    for (const chunk of build.returnedChunks) {
      for (let k = 0; k < chunk.originIndex.length; k++) {
        if (!Number.isNaN(chunk.range[k])) continue;
        seen++;
        const dx = chunk.direction[k * 3]!;
        const dy = chunk.direction[k * 3 + 1]!;
        const dz = chunk.direction[k * 3 + 2]!;
        expect(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz)).toBe(true);
        expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 5);
      }
    }
    expect(seen).toBe(scene.noReturnCells.length);
  });

  it('no sky cell lands in notReadChunks (NO_RETURN and NOT_DECODED stay ray-level distinct)', () => {
    expect(build.notReadChunks).toHaveLength(0);
  });
});

describe('F6 (ray-level): a strided-E57 NOT_DECODED cell produces a not-read ray, and only there', () => {
  const scene = buildF6Scene() as F6Scene;
  const cells = scene.width * scene.height;
  const cellState = new Uint8Array(cells).fill(CellState.NOT_DECODED);
  const cellToRecord = new Int32Array(cells).fill(NO_RECORD);
  const geometricRange = new Float32Array(cells).fill(Number.NaN);
  let record = 0;
  for (let row = 0; row < scene.height; row++) {
    for (let column = 0; column < scene.width; column++) {
      if (row % scene.stride !== 0 || column % scene.stride !== 0) continue;
      const idx = cellIndexOf(row, column, scene.width);
      cellState[idx] = CellState.VALID_RETURN;
      cellToRecord[idx] = record++;
      geometricRange[idx] = 12; // arbitrary finite declared range; not under test here
    }
  }
  const frame: OrganizedRangeFrame = {
    id: scene.station.id,
    sourceKind: 'e57-structured',
    width: scene.width,
    height: scene.height,
    cellState,
    cellToRecord,
    geometricRange,
    linkage: { kind: 'partial', reason: 'stride' },
    diagnostics: tallyCellStates(cellState),
  };
  const build = buildGriddedSourceRays(
    frame,
    stationFrom(scene.station, 'e57-scan', record),
    0,
    coverageFrom(scene.coverage),
    { kind: 'none' },
  );

  it('every NOT_DECODED cell lands in notReadChunks, with NaN range and a finite direction', () => {
    const notDecodedCount = frame.diagnostics.stateCounts[CellState.NOT_DECODED];
    expect(notDecodedCount).toBeGreaterThan(0);
    const total = build.notReadChunks.reduce((n, c) => n + c.originIndex.length, 0);
    expect(total).toBe(notDecodedCount);
    for (const chunk of build.notReadChunks) {
      for (let k = 0; k < chunk.range.length; k++) {
        expect(Number.isNaN(chunk.range[k])).toBe(true);
        const dx = chunk.direction[k * 3]!;
        const dy = chunk.direction[k * 3 + 1]!;
        const dz = chunk.direction[k * 3 + 2]!;
        expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 5);
      }
    }
  });

  it('no NOT_DECODED cell lands in returnedChunks', () => {
    const returnedCount = build.returnedChunks.reduce((n, c) => n + c.originIndex.length, 0);
    expect(returnedCount).toBe(frame.diagnostics.stateCounts[CellState.VALID_RETURN]);
  });
});

describe('F16 (ray-level): a multi-return cell contributes exactly one ray, not one per return', () => {
  const scene = buildF16Scene() as F16Scene;
  const cells = scene.width * scene.height;
  const cellState = new Uint8Array(cells).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(cells).fill(NO_RECORD);
  const entries: CellReturnInput[] = [];
  let record = 0;
  for (const cell of scene.cells) {
    const idx = cellIndexOf(cell.row, cell.column, scene.width);
    cellToRecord[idx] = record;
    for (const ret of cell.returns) {
      entries.push({
        row: cell.row,
        column: cell.column,
        record: record++,
        returnIndex: ret.returnIndex,
        returnCount: cell.returns.length,
        sourceRange: ret.range,
      });
    }
  }
  const built = buildCellReturns(scene.width, scene.height, entries);
  const frame: OrganizedRangeFrame = {
    id: scene.station.id,
    sourceKind: 'e57-structured',
    width: scene.width,
    height: scene.height,
    cellState,
    cellToRecord,
    returnCellStart: built.returnCellStart,
    returnRecord: built.returnRecord,
    returnIndex: built.returnIndex,
    returnCountDeclared: built.returnCountDeclared,
    returnSourceRange: built.returnSourceRange,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
  const build = buildGriddedSourceRays(
    frame,
    stationFrom(scene.station, 'e57-scan', record),
    0,
    coverageFrom(scene.coverage),
    { kind: 'none' },
  );

  it('returnedChunks holds one ray per cell, not one per declared return', () => {
    const rayCount = build.returnedChunks.reduce((n, c) => n + c.originIndex.length, 0);
    expect(rayCount).toBe(scene.cells.length);
    const totalReturns = scene.cells.reduce((n, c) => n + c.returns.length, 0);
    expect(totalReturns).toBeGreaterThan(scene.cells.length); // the fixture actually is multi-return
  });

  it("the return table reproduces the declared per-return ranges in ascending returnIndex order, first entry equals the chunk's own range[k]", () => {
    expect(build.returnTable).toBeDefined();
    const table = build.returnTable!;
    const chunk = build.returnedChunks[0]!;
    expect(table.countByRay.length).toBe(chunk.originIndex.length);
    for (let k = 0; k < scene.cells.length; k++) {
      const declared = [...scene.cells[k]!.returns].sort((a, b) => a.returnIndex - b.returnIndex);
      expect(table.countByRay[k]).toBe(declared.length);
      const offset = chunk.returnOffset[k]!;
      const got = Array.from(table.range.subarray(offset, offset + declared.length));
      expect(got).toEqual(declared.map((r) => r.range));
      expect(chunk.range[k]).toBeCloseTo(declared[0]!.range, 5);
    }
  });
});
