/**
 * A first classification on a scan that had none is one undoable step: Undo
 * takes the codes off again, Redo puts them back with the same provenance.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PointCloud } from '../src/model/PointCloud';
import { classificationDiffersFromSource, fullResWouldDropClassEdits } from '../src/export/fullResClassGuard';
import {
  ClassEditHistory,
  recordClassAttach,
  recordClassEdit,
  stepClassEdit,
} from '../src/render/measure/classEditHistory';

function unclassified(n = 6): PointCloud {
  return new PointCloud({
    positions: new Float32Array(n * 3).map((_, i) => i),
    origin: [0, 0, 0],
    sourceFormat: 'ply',
    name: 'grid.ply',
  });
}

describe('first classification attach', () => {
  it('derive on an unclassified cloud can be undone back to no classification', () => {
    const pc = unclassified();
    const h = new ClassEditHistory();
    const codes = Uint8Array.from([2, 2, 5, 6, 1, 2]);
    recordClassAttach(h, pc, codes, 'derive@1');
    expect(pc.classificationProvenance).toBe('derived');
    expect(h.canUndo).toBe(true);

    expect(stepClassEdit(h, pc, 'undo')).not.toBeNull();
    expect(pc.classification).toBeUndefined();
    expect(pc.classificationProvenance).toBe('none');
    expect(pc.originalClassification).toBeUndefined();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(true);

    expect(stepClassEdit(h, pc, 'redo')).not.toBeNull();
    expect(Array.from(pc.classification!)).toEqual([2, 2, 5, 6, 1, 2]);
    expect(pc.classificationProvenance).toBe('derived');
    expect(pc.derivedMethod).toBe('derive@1');
    expect(h.canRedo).toBe(false);
  });

  it('a one-class fill is undoable, and edits on top replay in order', () => {
    const pc = unclassified(4);
    const h = new ClassEditHistory();
    recordClassAttach(h, pc, new Uint8Array(4).fill(1));
    recordClassEdit(h, pc, (buf) => { buf[0] = 6; });
    expect(pc.classification![0]).toBe(6);

    stepClassEdit(h, pc, 'undo');
    expect(pc.classification![0]).toBe(1);
    stepClassEdit(h, pc, 'undo');
    expect(pc.classification).toBeUndefined();
    expect(stepClassEdit(h, pc, 'undo')).toBeNull();

    stepClassEdit(h, pc, 'redo');
    expect(Array.from(pc.classification!)).toEqual([1, 1, 1, 1]);
    stepClassEdit(h, pc, 'redo');
    expect(pc.classification![0]).toBe(6);
  });

  it('a fresh edit after undoing the attach drops the redo branch', () => {
    const pc = unclassified(3);
    const h = new ClassEditHistory();
    recordClassAttach(h, pc, new Uint8Array(3).fill(2));
    stepClassEdit(h, pc, 'undo');
    recordClassAttach(h, pc, new Uint8Array(3).fill(5));
    expect(h.canRedo).toBe(false);
    expect(h.depth).toBe(1);
  });

  it('the Viewer records the attach and drops aClass when it is undone', () => {
    const src = readFileSync(resolve(__dirname, '../src/render/Viewer.ts'), 'utf8');
    const apply = src.slice(src.indexOf('applyDerivedClassification(id: string'));
    expect(apply.slice(0, 1200)).toMatch(/recordClassAttach\(this\._historyFor\(id\), cloud, codes, method\)/);
    expect(src).toMatch(/deleteAttribute\('aClass'\)/);
  });
});

describe('full-resolution export after a first classification', () => {
  const refused = (pc: PointCloud, epoch: number) => fullResWouldDropClassEdits({
    fullRes: true,
    includeClassification: true,
    hasClassEdits: classificationDiffersFromSource(pc.classificationProvenance, epoch),
  });

  it('is refused once a derive attaches classes the source file does not hold', () => {
    const pc = unclassified(3);
    expect(refused(pc, 0)).toBe(false);
    recordClassAttach(new ClassEditHistory(), pc, Uint8Array.from([2, 5, 6]));
    expect(refused(pc, 1)).toBe(true);
  });

  it('is refused again after an undo then a redo, and allowed while undone', () => {
    const pc = unclassified(3);
    const h = new ClassEditHistory();
    recordClassAttach(h, pc, Uint8Array.from([2, 5, 6]));
    stepClassEdit(h, pc, 'undo');
    expect(refused(pc, 2)).toBe(false);
    stepClassEdit(h, pc, 'redo');
    expect(refused(pc, 3)).toBe(true);
  });

  it('counts source codes as changed once any edit touched them', () => {
    expect(classificationDiffersFromSource('source', 0)).toBe(false);
    expect(classificationDiffersFromSource('source', 1)).toBe(true);
    expect(classificationDiffersFromSource('cleared', 0)).toBe(true);
  });

  it('the export guard reads the source comparison, not undo availability', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toMatch(/hasClassEdits: \(\) => activeScanHasClassEdits\(/);
    const helper = readFileSync(resolve(__dirname, '../src/app/classLegendRefresh.ts'), 'utf8');
    expect(helper).toMatch(/classificationDiffersFromSource\([^\n]*classificationEpoch\(/);
  });
});
