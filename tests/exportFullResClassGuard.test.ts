/**
 * exportFullResClassGuard.test.ts
 *
 * Full-resolution export must never SILENTLY discard in-session classification
 * edits. Those edits live only in the display-resolution buffer and are keyed
 * by display-point index; a full-resolution export re-decodes the original file
 * from scratch and cannot carry them (the display cloud holds no stable
 * source-record index, and the stratified/jittered stride plus the non-finite
 * point compaction in sanitizeCloud make the display→source mapping
 * unrecoverable). Rather than guess a remapping, the app REFUSES a classified
 * full-resolution export while edits are present, and steers the user to the
 * two lossless paths: omit classification, or export at display resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateFullResClassExport,
  fullResWouldDropClassEdits,
} from '../src/export/fullResClassGuard';
import { ClassEditHistory, recordEdit } from '../src/render/measure/classEditHistory';
import { applyIndexReclassify } from '../src/render/measure/classificationEditor';

describe('evaluateFullResClassExport', () => {
  it('refuses a classified full-resolution export while class edits are present', () => {
    const d = evaluateFullResClassExport({
      fullRes: true,
      includeClassification: true,
      hasClassEdits: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBeTruthy();
    // The message must point at the two lossless escapes, not blame the user.
    expect(d.reason).toMatch(/full resolution|classification/i);
  });

  it('allows a full-resolution export when classification is omitted', () => {
    const d = evaluateFullResClassExport({
      fullRes: true,
      includeClassification: false,
      hasClassEdits: true,
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it('allows a full-resolution classified export when there are no edits', () => {
    const d = evaluateFullResClassExport({
      fullRes: true,
      includeClassification: true,
      hasClassEdits: false,
    });
    expect(d.allowed).toBe(true);
  });

  it('always allows a display-resolution export (edits are preserved there)', () => {
    // A display-resolution export converts the live display cloud, so the
    // index-keyed edits are already applied — never refused.
    const d = evaluateFullResClassExport({
      fullRes: false,
      includeClassification: true,
      hasClassEdits: true,
    });
    expect(d.allowed).toBe(true);
  });

  it('is a pure decision over flags, independent of point coordinates', () => {
    // The refusal keys on the EDIT/flag state, never on positions — duplicate
    // coordinates can never steer it to a wrong record because it does no
    // position-based remapping at all.
    const a = evaluateFullResClassExport({
      fullRes: true,
      includeClassification: true,
      hasClassEdits: true,
    });
    const b = evaluateFullResClassExport({
      fullRes: true,
      includeClassification: true,
      hasClassEdits: true,
    });
    expect(a).toEqual(b);
  });
});

describe('undo then export — the guard tracks the live edit state', () => {
  it('re-allows a full-res classified export once every edit is undone, and the display buffer matches the undone state', () => {
    // Two coincident points (duplicate coordinates) — a reclassify keyed purely
    // by index, so the duplicate can never steer the edit to the wrong record.
    const cls = new Uint8Array([1, 1, 2, 2]);
    const original = cls.slice();
    const history = new ClassEditHistory();

    // Edit index 0 → class 6. hasClassEdits is host-derived from canUndo.
    recordEdit(history, cls, () => applyIndexReclassify(cls, [0], 6));
    const withEdits = () =>
      evaluateFullResClassExport({
        fullRes: true,
        includeClassification: true,
        hasClassEdits: history.canUndo,
      });
    expect(withEdits().allowed).toBe(false);

    // Undo restores index 0 to its previous class; the display buffer (what a
    // display-resolution export reads) now equals the original.
    history.undo(cls);
    expect(Array.from(cls)).toEqual(Array.from(original));
    expect(withEdits().allowed).toBe(true);
  });
});

describe('fullResWouldDropClassEdits', () => {
  it('is true only for the exact lossy combination', () => {
    expect(
      fullResWouldDropClassEdits({ fullRes: true, includeClassification: true, hasClassEdits: true }),
    ).toBe(true);
    expect(
      fullResWouldDropClassEdits({ fullRes: true, includeClassification: false, hasClassEdits: true }),
    ).toBe(false);
    expect(
      fullResWouldDropClassEdits({ fullRes: false, includeClassification: true, hasClassEdits: true }),
    ).toBe(false);
    expect(
      fullResWouldDropClassEdits({ fullRes: true, includeClassification: true, hasClassEdits: false }),
    ).toBe(false);
  });
});
