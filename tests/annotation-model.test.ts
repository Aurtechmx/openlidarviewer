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
