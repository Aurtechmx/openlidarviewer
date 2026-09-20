/**
 * The canonical visibility reducer, and the overwrite it exists to prevent.
 *
 * Before this, the replace frontier and the draw frustum would each have
 * written `mesh.visible` directly, so whichever ran last won: a node the
 * frustum had hidden reappeared when the frontier recomputed, and a parent the
 * frontier had withheld returned the moment the camera moved. These pin the
 * composition and the independence of each reason.
 */
import { describe, it, expect } from 'vitest';
import {
  isDrawn,
  hidingReason,
  VisibilityReasonStore,
  VISIBLE,
  type NodeVisibilityReasons,
} from '../src/render/streaming/visibilityReasons';

describe('composition', () => {
  it('draws only when every reason declines to hide', () => {
    expect(isDrawn(VISIBLE)).toBe(true);
    expect(isDrawn(undefined)).toBe(true);
    expect(isDrawn({ replaceHidden: false, frustumHidden: false })).toBe(true);
  });

  it('treats any single reason as a veto', () => {
    for (const r of ['replaceHidden', 'frustumHidden', 'lifecycleHidden'] as const) {
      expect(isDrawn({ [r]: true } as NodeVisibilityReasons), r).toBe(false);
    }
  });

  it('names which reason is hiding a node', () => {
    expect(hidingReason(VISIBLE)).toBeNull();
    expect(hidingReason({ frustumHidden: true })).toBe('frustumHidden');
    expect(hidingReason({ replaceHidden: true, frustumHidden: true })).toBe('replaceHidden');
  });
});

describe('reasons stay independent', () => {
  it('setting the frustum reason does not clear a replace hide', () => {
    const s = new VisibilityReasonStore();
    s.set('a', 'replaceHidden', true);
    s.set('a', 'frustumHidden', false);
    expect(s.drawn('a')).toBe(false);
    expect(s.reasonsFor('a').replaceHidden).toBe(true);
  });

  it('setting the replace reason does not clear a frustum hide', () => {
    const s = new VisibilityReasonStore();
    s.set('a', 'frustumHidden', true);
    s.set('a', 'replaceHidden', false);
    expect(s.drawn('a')).toBe(false);
  });

  it('needs both reasons cleared before a node draws again', () => {
    const s = new VisibilityReasonStore();
    s.set('a', 'replaceHidden', true);
    s.set('a', 'frustumHidden', true);
    expect(s.drawn('a')).toBe(false);
    s.set('a', 'frustumHidden', false);
    expect(s.drawn('a')).toBe(false);
    s.set('a', 'replaceHidden', false);
    expect(s.drawn('a')).toBe(true);
  });
});

describe('a shrinking hidden set un-hides what it no longer covers', () => {
  it('clears the reason for ids absent from the new set', () => {
    const s = new VisibilityReasonStore();
    const ids = ['a', 'b', 'c'];
    s.setFromHiddenSet(ids, 'frustumHidden', new Set(['a', 'b']));
    expect([s.drawn('a'), s.drawn('b'), s.drawn('c')]).toEqual([false, false, true]);
    s.setFromHiddenSet(ids, 'frustumHidden', new Set(['b']));
    expect([s.drawn('a'), s.drawn('b'), s.drawn('c')]).toEqual([true, false, true]);
  });

  it('leaves the other reason alone while doing it', () => {
    const s = new VisibilityReasonStore();
    s.set('a', 'replaceHidden', true);
    s.setFromHiddenSet(['a'], 'frustumHidden', new Set());
    expect(s.drawn('a')).toBe(false);
    expect(hidingReason(s.reasonsFor('a'))).toBe('replaceHidden');
  });
});

describe('lifetime', () => {
  it('forgets a node so a reused id starts visible', () => {
    const s = new VisibilityReasonStore();
    s.set('a', 'frustumHidden', true);
    s.forget('a');
    expect(s.drawn('a')).toBe(true);
    expect([...s.ids()]).not.toContain('a');
  });

  it('clears everything', () => {
    const s = new VisibilityReasonStore();
    s.set('a', 'frustumHidden', true);
    s.set('b', 'replaceHidden', true);
    s.clear();
    expect([...s.ids()]).toHaveLength(0);
    expect(s.drawn('a')).toBe(true);
  });
});
