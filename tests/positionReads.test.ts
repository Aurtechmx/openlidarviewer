/**
 * tests/positionReads.test.ts
 *
 * Three scripts count direct `.positions` reads: the gate (lint:position-access,
 * shrink-only plus a frame per read), the doc cross-check
 * (lint:architecture-truth), and the report (lint:positions-reads). They used to
 * hold three textually identical private copies of the walk and the counting
 * rule, and the copies were free to drift: the gate reported one total, the
 * cross-check another, and nothing in the repo explained the gap. A lint whose
 * job is stopping documents contradicting the tree cannot be the thing
 * contradicting the gate.
 *
 * The rule now lives in scripts/lib/positionReads.mjs. These cases pin what it
 * counts (so nobody silently narrows the gate by "tidying" the regex), and the
 * one property that keeps the two scopes explainable: they differ by the reads
 * in `src/model/` and by nothing else.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SCOPES,
  readsOnLine,
  countPositionReads,
  positionReadLines,
  scanPositionReads,
  walkPositionSources,
} from '../scripts/lib/positionReads.mjs';

const SRC = resolve(__dirname, '../src');

describe('what counts as a direct .positions read', () => {
  it('counts a plain read, and counts twice on a line holding two', () => {
    expect(readsOnLine('const p = cloud.positions;')).toBe(1);
    expect(readsOnLine('mix(a.positions, b.positions);')).toBe(2);
  });

  it('ignores comment lines, so explaining the migration never fires the gate', () => {
    expect(readsOnLine('// reads cloud.positions directly')).toBe(0);
    expect(readsOnLine(' * the .positions buffer is written once')).toBe(0);
    expect(readsOnLine('/* cloud.positions */')).toBe(0);
  });

  it('ignores a trailing comment but keeps the code before it', () => {
    expect(readsOnLine('use(cloud.positions); // and not b.positions')).toBe(1);
  });

  it('requires a word boundary, so .positionsBuffer is not a read', () => {
    expect(readsOnLine('const b = cloud.positionsBuffer;')).toBe(0);
    expect(readsOnLine('const p = positions;')).toBe(0);
  });

  it('totals a file the same way the line rule does', () => {
    const text = [
      '// cloud.positions in prose',
      'const a = cloud.positions;',
      'copy(x.positions, y.positions);',
    ].join('\n');
    expect(countPositionReads(text)).toBe(3);
    expect(positionReadLines(text)).toEqual([
      { line: 2, text: 'const a = cloud.positions;', count: 1 },
      { line: 3, text: 'copy(x.positions, y.positions);', count: 2 },
    ]);
  });

  it('reports the same sites the total is built from', () => {
    for (const file of walkPositionSources(SRC, SCOPES['all-src']).slice(0, 40)) {
      const text = readFileSync(file, 'utf8');
      const fromLines = positionReadLines(text).reduce((a, h) => a + h.count, 0);
      expect(fromLines).toBe(countPositionReads(text));
    }
  });
});

describe('the two scopes differ only by src/model/', () => {
  it('never walks a test file, in either scope', () => {
    for (const id of ['all-src', 'outside-model']) {
      const files = walkPositionSources(SRC, SCOPES[id]);
      expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
      expect(files.length).toBeGreaterThan(0);
    }
  });

  it('excludes src/model/ from outside-model and includes it in all-src', () => {
    const all = walkPositionSources(SRC, SCOPES['all-src']);
    const outside = walkPositionSources(SRC, SCOPES['outside-model']);
    const inModel = (f: string) => f.includes(`${SRC}/model/`);
    expect(all.some(inModel)).toBe(true);
    expect(outside.some(inModel)).toBe(false);
    expect(all.filter((f) => !inModel(f))).toEqual(outside);
  });

  it('accounts for the whole gap between the two totals', () => {
    const all = scanPositionReads(SRC, 'all-src');
    const outside = scanPositionReads(SRC, 'outside-model');

    let modelReads = 0;
    let modelFiles = 0;
    for (const [file, n] of all.byFile) {
      if (!file.includes(`${SRC}/model/`)) {
        // Every non-model file is counted identically in both scopes; a
        // per-file difference would mean the scopes disagree about a read
        // rather than about which files to look at.
        expect(outside.byFile.get(file)).toBe(n);
        continue;
      }
      modelReads += n;
      modelFiles += 1;
    }

    expect(all.total - outside.total).toBe(modelReads);
    expect(all.fileCount - outside.fileCount).toBe(modelFiles);
  });

  it('refuses an unknown scope rather than guessing one', () => {
    expect(() => scanPositionReads(SRC, 'everything')).toThrow(/unknown position-read scope/);
  });
});

describe('the gate baseline is recorded in the gate scope', () => {
  it('records no file the all-src walk cannot reach, and no test file', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(__dirname, '../docs/validation/position-access-baseline.json'), 'utf8'),
    ) as { total: number; files: Record<string, number> };
    const all = scanPositionReads(SRC, 'all-src');
    const scanned = new Set(
      [...all.byFile.keys()].map((f) =>
        f.slice(resolve(__dirname, '..').length + 1),
      ),
    );
    for (const file of Object.keys(baseline.files)) {
      expect(file.endsWith('.test.ts')).toBe(false);
      expect(file.startsWith('src/')).toBe(true);
    }
    // Shrink-only: the tree may hold fewer reads than the baseline banks, never
    // more, and never in a file the baseline has never seen.
    expect(all.total).toBeLessThanOrEqual(baseline.total);
    for (const file of scanned) expect(baseline.files[file]).toBeDefined();
  });
});
