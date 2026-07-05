/**
 * captureLens.test.ts
 *
 * Pins the v0.5.7 capture lens: the shared predicate that composes the shape
 * verdict and display profile into "is this an airborne survey/terrain dataset,
 * or a capture scan where survey/terrain framing does not apply?". The facets
 * gate different wrongness, so they are asserted independently.
 */

import { describe, it, expect } from 'vitest';
import { captureLensFor } from '../src/render/captureLens';

describe('captureLensFor', () => {
  it('georeferenced survey terrain is not a capture scan', () => {
    expect(captureLensFor('terrain', 'geo')).toEqual({
      isNonTerrain: false,
      isLocalFrame: false,
      isCaptureScan: false,
    });
  });

  it('an object-shaped local E57 is a capture scan on both facets', () => {
    expect(captureLensFor('object', 'terrestrial-scan')).toEqual({
      isNonTerrain: true,
      isLocalFrame: true,
      isCaptureScan: true,
    });
  });

  it('interior counts as non-terrain', () => {
    expect(captureLensFor('interior', 'geo').isNonTerrain).toBe(true);
  });

  it('a terrain-shaped local scan keeps terrain but flags the local frame', () => {
    const l = captureLensFor('terrain', 'terrestrial-scan');
    expect(l.isNonTerrain).toBe(false);
    expect(l.isLocalFrame).toBe(true);
    expect(l.isCaptureScan).toBe(true);
  });

  it('an object-shaped georeferenced scan is a capture scan via shape only', () => {
    const l = captureLensFor('object', 'geo');
    expect(l.isNonTerrain).toBe(true);
    expect(l.isLocalFrame).toBe(false);
    expect(l.isCaptureScan).toBe(true);
  });

  it('handheld and mesh profiles are local frame', () => {
    expect(captureLensFor('object', 'handheld-scan').isLocalFrame).toBe(true);
    expect(captureLensFor(null, 'mesh').isLocalFrame).toBe(true);
  });

  it('an unknown shape on the geo path is not a capture scan', () => {
    expect(captureLensFor(null, 'geo').isCaptureScan).toBe(false);
  });
});
