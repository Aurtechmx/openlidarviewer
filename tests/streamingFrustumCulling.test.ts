/**
 * streamingFrustumCulling.test.ts — resident is not the same as drawn.
 *
 * Every point mesh is built by the Viewer's shared builder, which disables
 * frustum culling. For a streamed node that meant a node held warm in the cache
 * was submitted for drawing whether or not it was in front of the camera.
 *
 * The rule the tests hold: a node outside the view is not drawn and stays
 * resident, a node inside or straddling the view is drawn, and the arithmetic
 * errs toward drawing. A false positive costs a draw call; a false negative
 * hides data the user is looking at.
 */

import { describe, it, expect } from 'vitest';
import {
  boxIntersectsFrustum,
  boundsInRenderFrame,
  cullResidentNodes,
  type Box6,
  type FrustumPlanes,
  type Plane,
} from '../src/render/streaming/nodeFrustumCulling';

const plane = (a: number, b: number, c: number, d: number): Plane => ({ a, b, c, d });

/**
 * An axis-aligned box from -10..10 in x and y, and -100..0 in z, as six inward
 * planes. Stands in for both camera kinds: perspective and orthographic differ
 * only in the planes they produce.
 */
const BOXY_FRUSTUM: FrustumPlanes = [
  plane(1, 0, 0, 10),    // x >= -10
  plane(-1, 0, 0, 10),   // x <=  10
  plane(0, 1, 0, 10),    // y >= -10
  plane(0, -1, 0, 10),   // y <=  10
  plane(0, 0, -1, 0),    // z <=   0
  plane(0, 0, 1, 100),   // z >= -100
];

const box = (cx: number, cy: number, cz: number, r = 1): Box6 =>
  [cx - r, cy - r, cz - r, cx + r, cy + r, cz + r];

describe('a box against the view', () => {
  it('draws a box fully inside', () => {
    expect(boxIntersectsFrustum(box(0, 0, -50), BOXY_FRUSTUM)).toBe(true);
  });

  it('skips a box fully outside, on every side', () => {
    expect(boxIntersectsFrustum(box(50, 0, -50), BOXY_FRUSTUM)).toBe(false);
    expect(boxIntersectsFrustum(box(-50, 0, -50), BOXY_FRUSTUM)).toBe(false);
    expect(boxIntersectsFrustum(box(0, 50, -50), BOXY_FRUSTUM)).toBe(false);
    expect(boxIntersectsFrustum(box(0, -50, -50), BOXY_FRUSTUM)).toBe(false);
    expect(boxIntersectsFrustum(box(0, 0, 50), BOXY_FRUSTUM)).toBe(false);
    expect(boxIntersectsFrustum(box(0, 0, -500), BOXY_FRUSTUM)).toBe(false);
  });

  it('draws a box straddling a plane', () => {
    // Half in, half out. Culling it would tear a hole at the screen edge.
    expect(boxIntersectsFrustum(box(10, 0, -50, 3), BOXY_FRUSTUM)).toBe(true);
  });

  it('draws a box that encloses the camera', () => {
    expect(boxIntersectsFrustum([-1000, -1000, -1000, 1000, 1000, 1000], BOXY_FRUSTUM)).toBe(true);
  });

  it('draws a box touching a plane exactly', () => {
    // On the boundary is in front of it, not behind. Errs toward drawing.
    expect(boxIntersectsFrustum([10, -1, -50, 12, 1, -48], BOXY_FRUSTUM)).toBe(true);
  });
});

describe('bounds moved into the render frame', () => {
  it('subtracts the render origin from both corners', () => {
    const shifted = boundsInRenderFrame([600000, 4600000, 10, 600010, 4600010, 20], [600000, 4600000, 0]);
    expect(shifted).toEqual([0, 0, 10, 10, 10, 20]);
  });

  it('decides a survey-coordinate node by its shifted bounds, not its raw ones', () => {
    // Large projected coordinates: unshifted, the node sits far outside the
    // frustum and would be culled although it is what the camera is looking at.
    const bounds: Box6 = [600000 - 5, 4600000 - 5, -55, 600000 + 5, 4600000 + 5, -45];
    const origin: readonly [number, number, number] = [600000, 4600000, 0];

    expect(boxIntersectsFrustum(bounds, BOXY_FRUSTUM)).toBe(false);
    expect(boxIntersectsFrustum(boundsInRenderFrame(bounds, origin), BOXY_FRUSTUM)).toBe(true);
  });
});

describe('splitting resident nodes', () => {
  const nodes = [
    { key: 'in', bounds: box(0, 0, -50) },
    { key: 'left', bounds: box(-50, 0, -50) },
    { key: 'behind', bounds: box(0, 0, 50) },
    { key: 'edge', bounds: box(10, 0, -50, 3) },
  ];

  it('draws what is visible and keeps the rest', () => {
    const d = cullResidentNodes(nodes, BOXY_FRUSTUM);
    expect(d.drawn).toEqual(['in', 'edge']);
    expect(d.residentNotDrawn).toEqual(['left', 'behind']);
  });

  it('accounts for every resident node exactly once', () => {
    // Nothing may be dropped: a node missing from both lists would be neither
    // drawn nor kept, which is how a culling change loses data.
    const d = cullResidentNodes(nodes, BOXY_FRUSTUM);
    expect([...d.drawn, ...d.residentNotDrawn].sort()).toEqual(nodes.map((n) => n.key).sort());
  });

  it('keeps an off-screen node resident rather than evicting it', () => {
    const d = cullResidentNodes(nodes, BOXY_FRUSTUM);
    expect(d.residentNotDrawn).toContain('left');
  });

  it('draws everything when the camera turns back', () => {
    const wideOpen: FrustumPlanes = [
      plane(1, 0, 0, 1e6), plane(-1, 0, 0, 1e6),
      plane(0, 1, 0, 1e6), plane(0, -1, 0, 1e6),
      plane(0, 0, 1, 1e6), plane(0, 0, -1, 1e6),
    ];
    expect(cullResidentNodes(nodes, wideOpen).residentNotDrawn).toEqual([]);
  });
});
