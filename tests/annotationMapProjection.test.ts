/**
 * annotationMapProjection.test.ts
 *
 * The map sheet plots each annotation as a marker, and a marker in the wrong
 * place on a georeferenced sheet is worse than no marker at all — it asserts a
 * location the data does not support. This file pins the ONE piece of maths that
 * decides where a marker lands: the frame conversion + the page projection.
 *
 * The load-bearing fact (see the helper's own comment): the contour model is
 * built in the CANONICAL Z-up survey frame, while an annotation's localPosition
 * is in the RAW scene frame the cloud is drawn from. A Z-up scene needs no
 * rotation; a Y-up scene needs the same (x,y,z)→(x,-z,y) rotation the terrain
 * gather applied, so the marker sits on the contour it was placed over. Getting
 * this wrong plots the marker off-map or mirrored — the exact failure the
 * canonical-frame module warns about.
 */
import { describe, it, expect } from 'vitest';
import {
  annotationToMapXY,
  projectAnnotationToPage,
} from '../src/render/measure/annotationMapProjection';

describe('annotationToMapXY — scene frame → map (contour) frame', () => {
  it('a Z-up scene needs no rotation: horizontal is (x, y)', () => {
    expect(annotationToMapXY({ x: 30, y: 40, z: 200 }, 'z')).toEqual({ x: 30, y: 40 });
  });

  it('a Y-up scene rotates like the terrain gather: (x, y, z) → map (x, -z)', () => {
    // The gather rotates a Y-up buffer (x,y,z)→(x,-z,y); the first two canonical
    // components are (x, -z). Elevation (scene y) drops out of the ground plan.
    expect(annotationToMapXY({ x: 30, y: 200, z: -40 }, 'y')).toEqual({ x: 30, y: 40 });
  });
});

describe('projectAnnotationToPage — hand-computed page placement', () => {
  // A square ground bbox 0..100 in both axes, mapped by an identity-ish fit
  // transform: scale 2 page-pt per ground unit, page origin (ox, oy) = (12, 20).
  //   pageX = ox + (mapX - minX) * scale
  //   pageY = oy + (mapY - minY) * scale
  const bbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const t = { ox: 12, oy: 20, scale: 2 };

  it('places a Z-up annotation inside the bbox at the computed page point', () => {
    // local (25, 60) → map (25, 60) → pageX = 12 + 25*2 = 62, pageY = 20 + 60*2 = 140.
    const p = projectAnnotationToPage({ x: 25, y: 60, z: 999 }, 'z', bbox, t);
    expect(p.insideBbox).toBe(true);
    expect(p.pageX).toBeCloseTo(62, 6);
    expect(p.pageY).toBeCloseTo(140, 6);
  });

  it('flags an annotation outside the bbox (still projected, not placed on the map)', () => {
    // local (150, 60) → map (150, 60): mapX 150 > maxX 100, so it is off-map.
    const p = projectAnnotationToPage({ x: 150, y: 60, z: 0 }, 'z', bbox, t);
    expect(p.insideBbox).toBe(false);
  });

  it('projects a Y-up annotation through the rotation before the fit transform', () => {
    // local (25, 999, -60) with a Y-up scene → map (25, 60) → same page point as
    // the Z-up case above. Proves the rotation happens BEFORE the projection.
    const p = projectAnnotationToPage({ x: 25, y: 999, z: -60 }, 'y', bbox, t);
    expect(p.insideBbox).toBe(true);
    expect(p.pageX).toBeCloseTo(62, 6);
    expect(p.pageY).toBeCloseTo(140, 6);
  });

  it('treats the bbox edges as inside (inclusive)', () => {
    expect(projectAnnotationToPage({ x: 0, y: 0, z: 0 }, 'z', bbox, t).insideBbox).toBe(true);
    expect(projectAnnotationToPage({ x: 100, y: 100, z: 0 }, 'z', bbox, t).insideBbox).toBe(true);
  });
});
