/**
 * nodeFrustumCulling.ts — whether a resident streaming node is in front of the
 * camera, decided from its own bounds.
 *
 * Every point mesh, static or streamed, is built by the Viewer's shared
 * `buildPointMesh`, which sets `frustumCulled = false`. That is right for a
 * static cloud whose bounds the renderer does not own, and wrong for a streamed
 * node: the scheduler already knows each node's authoritative bounds, and a
 * node held warm in the cache was being submitted for drawing whether or not it
 * was in front of the camera.
 *
 * Residency and visibility are separate decisions. A node outside the view
 * stays resident, keeps its decoded chunk, and remains pickable by the tools
 * that read chunks directly; it is only skipped by the draw. Nothing here
 * evicts anything.
 *
 * Pure, and free of three.js so the arithmetic can be tested without a
 * renderer. The caller supplies the six frustum planes it already has.
 */

/** A plane as ax + by + cz + d = 0, normal (a, b, c) pointing INTO the frustum. */
export interface Plane {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

/** The six planes of a view frustum, in any order. */
export type FrustumPlanes = readonly [Plane, Plane, Plane, Plane, Plane, Plane];

/** An axis-aligned box as [minX, minY, minZ, maxX, maxY, maxZ]. */
export type Box6 = readonly [number, number, number, number, number, number];

/**
 * Shift a node's world bounds into the frame the renderer draws in.
 *
 * Streamed positions are uploaded relative to a render origin so a survey
 * easting stays inside Float32's usable range. The bounds the scheduler holds
 * are in source coordinates, so they have to be moved by the same origin before
 * they can be compared with a frustum built from the render camera. Getting
 * this wrong culls everything or nothing, which is why it is a named step
 * rather than an inline subtraction.
 */
export function boundsInRenderFrame(
  bounds: Box6,
  renderOrigin: readonly [number, number, number],
): Box6 {
  const [ox, oy, oz] = renderOrigin;
  return [
    bounds[0] - ox,
    bounds[1] - oy,
    bounds[2] - oz,
    bounds[3] - ox,
    bounds[4] - oy,
    bounds[5] - oz,
  ];
}

/**
 * Whether a box is anywhere inside the frustum.
 *
 * Tests the box's most-positive corner along each plane normal. A box is
 * outside only when that corner is behind a plane, which no part of the box can
 * then be in front of. The test is CONSERVATIVE: a box straddling a plane, or
 * one enclosing the camera, is reported visible. A false positive costs a draw;
 * a false negative hides data the user is looking at, so the arithmetic errs
 * toward drawing.
 *
 * Boxes and planes must already be in the same frame. Orthographic and
 * perspective cameras differ only in the planes they produce, so both work
 * without a special case.
 */
export function boxIntersectsFrustum(box: Box6, planes: FrustumPlanes): boolean {
  for (const p of planes) {
    // The corner furthest along this plane's normal.
    const x = p.a >= 0 ? box[3] : box[0];
    const y = p.b >= 0 ? box[4] : box[1];
    const z = p.c >= 0 ? box[5] : box[2];
    if (p.a * x + p.b * y + p.c * z + p.d < 0) return false;
  }
  return true;
}

/** A resident node as this module needs to see it. */
export interface CullableNode {
  readonly key: string;
  readonly bounds: Box6;
}

/** What the renderer should draw, and what it should keep without drawing. */
export interface CullDecision {
  readonly drawn: readonly string[];
  readonly residentNotDrawn: readonly string[];
}

/**
 * Split resident nodes into those to draw and those to keep warm.
 *
 * The second list is the point: those nodes stay resident. A caller that
 * evicted them would turn a draw optimisation into repeated re-streaming the
 * moment the camera turned back.
 */
export function cullResidentNodes(
  nodes: readonly CullableNode[],
  planes: FrustumPlanes,
  renderOrigin: readonly [number, number, number] = [0, 0, 0],
): CullDecision {
  const drawn: string[] = [];
  const residentNotDrawn: string[] = [];
  for (const n of nodes) {
    const box = boundsInRenderFrame(n.bounds, renderOrigin);
    if (boxIntersectsFrustum(box, planes)) drawn.push(n.key);
    else residentNotDrawn.push(n.key);
  }
  return { drawn, residentNotDrawn };
}

/**
 * Adapt the scheduler's frustum planes to this module's shape.
 *
 * `streamingScore` already derives the six planes from a view-projection by
 * Gribb and Hartmann, and that derivation is tested. It represents a plane as
 * a tuple and this module as an object, which is a difference in spelling
 * rather than in mathematics, so the conversion happens here and the
 * derivation stays in one place. Writing a second extraction would give the
 * scheduler and the draw two chances to disagree about where the camera is
 * looking.
 *
 * Both use the same convention: a point is inside when `ax + by + cz + d >= 0`.
 * Neither normalises, which the intersection test does not need.
 */
export function planesFromTuples(
  tuples: readonly (readonly [number, number, number, number])[],
): FrustumPlanes {
  if (tuples.length !== 6) {
    throw new Error(`planesFromTuples: expected 6 planes, received ${tuples.length}`);
  }
  const p = tuples.map(([a, b, c, d]) => ({ a, b, c, d }));
  return [p[0], p[1], p[2], p[3], p[4], p[5]] as FrustumPlanes;
}
