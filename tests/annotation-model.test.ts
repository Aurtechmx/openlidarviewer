import { describe, it, expect } from 'vitest';
import {
  createAnnotation,
  editAnnotation,
  isAnnotationType,
  freshAnnotationId,
  ANNOTATION_TYPES,
} from '../src/render/annotate/types';

describe('createAnnotation', () => {
  it('fills the id and the created/updated timestamps', () => {
    const a = createAnnotation(
      { title: 'Weld', type: 'issue', localPosition: { x: 1, y: 2, z: 3 } },
      5000,
    );
    expect(typeof a.id).toBe('string');
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.createdAt).toBe(5000);
    expect(a.updatedAt).toBe(5000);
    expect(a.title).toBe('Weld');
    expect(a.type).toBe('issue');
    expect(a.localPosition).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('defaults an empty title and drops an empty note', () => {
    const a = createAnnotation(
      { title: '   ', note: '   ', type: 'note', localPosition: { x: 0, y: 0, z: 0 } },
      1,
    );
    expect(a.title).toBe('Annotation');
    expect(a.note).toBeUndefined();
  });

  it('clones the position so a later mutation cannot leak in', () => {
    const pos = { x: 1, y: 1, z: 1 };
    const a = createAnnotation({ title: 'P', type: 'note', localPosition: pos }, 1);
    pos.x = 999;
    expect(a.localPosition.x).toBe(1);
  });

  it('gives each annotation a distinct id', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(freshAnnotationId());
    expect(ids.size).toBe(200);
  });
});

describe('editAnnotation', () => {
  const base = createAnnotation(
    { title: 'Original', type: 'note', localPosition: { x: 0, y: 0, z: 0 } },
    1000,
  );

  it('changes the title and refreshes updatedAt without mutating the original', () => {
    const next = editAnnotation(base, { title: 'Renamed' }, 2000);
    expect(next.title).toBe('Renamed');
    expect(next.updatedAt).toBe(2000);
    expect(next.createdAt).toBe(1000);
    expect(base.title).toBe('Original'); // the original is untouched
    expect(base.updatedAt).toBe(1000);
  });

  it('changes the type', () => {
    expect(editAnnotation(base, { type: 'warning' }, 2000).type).toBe('warning');
  });

  it('sets and then clears the note', () => {
    const withNote = editAnnotation(base, { note: 'See photo' }, 2000);
    expect(withNote.note).toBe('See photo');
    const cleared = editAnnotation(withNote, { note: '' }, 3000);
    expect(cleared.note).toBeUndefined();
  });

  it('links and unlinks a measurement', () => {
    const linked = editAnnotation(base, { linkedMeasurementId: 'm1' }, 2000);
    expect(linked.linkedMeasurementId).toBe('m1');
    const unlinked = editAnnotation(linked, { linkedMeasurementId: null }, 3000);
    expect(unlinked.linkedMeasurementId).toBeUndefined();
  });

  it('keeps the existing title when an edit would blank it', () => {
    const next = editAnnotation(base, { title: '   ' }, 2000);
    expect(next.title).toBe('Original');
  });
});

describe('isAnnotationType / ANNOTATION_TYPES', () => {
  it('accepts the four valid types and rejects anything else', () => {
    for (const t of ANNOTATION_TYPES) expect(isAnnotationType(t)).toBe(true);
    expect(isAnnotationType('banana')).toBe(false);
    expect(isAnnotationType(undefined)).toBe(false);
    expect(isAnnotationType(3)).toBe(false);
  });

  it('lists exactly the four types', () => {
    expect([...ANNOTATION_TYPES].sort()).toEqual(['info', 'issue', 'note', 'warning']);
  });
});

// --- annotation position stability ------------------------

describe('annotation position stability under streaming refinement', () => {
  it('createAnnotation captures the local-space anchor exactly, free of any node reference', () => {
    const pos = { x: 12.5, y: -7.25, z: 3.75 };
    const a = createAnnotation({ title: 'P', type: 'note', localPosition: pos }, 1);
    // The marker is anchored to the cloud's coordinate system, not to any
    // specific COPC node. A later refinement (a deeper node replacing a
    // coarser one over the same volume) does not change this position.
    expect(a.localPosition).toEqual(pos);
    // The anchor object must be a clone so a later mutation upstream cannot
    // shift the annotation — the same invariant streaming refinement relies on.
    expect(a.localPosition).not.toBe(pos);
  });

  it('editAnnotation never touches localPosition — refinement preserves the anchor', () => {
    const a = createAnnotation(
      { title: 'Origin', type: 'issue', localPosition: { x: 1.5, y: 2.5, z: 3.5 } },
      1000,
    );
    const after = editAnnotation(
      a,
      { title: 'After refine', note: 'now we see more detail', type: 'note' },
      2000,
    );
    // Every editable field changed, but the world-space anchor stayed put.
    expect(after.title).toBe('After refine');
    expect(after.note).toBe('now we see more detail');
    expect(after.type).toBe('note');
    expect(after.localPosition).toEqual({ x: 1.5, y: 2.5, z: 3.5 });
    // And the original is untouched — the model is immutable.
    expect(a.localPosition).toEqual({ x: 1.5, y: 2.5, z: 3.5 });
  });
});
