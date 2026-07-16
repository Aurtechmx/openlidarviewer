/**
 * OBJ loader.
 *
 * Reads a Wavefront OBJ with `@loaders.gl/obj` and treats its vertex
 * positions as a point set. OBJ files can carry global survey coordinates —
 * this app's own exporter writes them — so positions are staged in float64
 * and recentred through the coordinate bridge before the float32 downcast.
 *
 * loaders.gl only emits geometry referenced by f/l/p statements, so a
 * vertex-only OBJ (a point cloud, including this app's own exports) parses
 * to zero points there; the `v` records are the point set in that case, and
 * they are read from the text in float64 — the loader narrows every
 * coordinate to float32 during parsing, which would quantise survey-scale
 * values onto a ~0.25 m grid before recentring could save them.
 */

import { parse } from '@loaders.gl/core';
import { OBJLoader } from '@loaders.gl/obj';
import { PointCloud } from '../model/PointCloud';
import { computeOrigin, recenter } from './coordinateBridge';

/**
 * Parse the `v x y z` records of an OBJ in float64, in file order. Mirrors
 * the loaders.gl tokenisation so a count comparison against its de-indexed
 * output is meaningful.
 */
function readVertexRecords(text: string): Float64Array {
  const out: number[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (line.length < 2 || line[0] !== 'v') continue;
    const after = line[1];
    if (after !== ' ' && after !== '\t') continue; // vn / vt / vp records
    const tok = line.split(/\s+/);
    out.push(Number(tok[1]), Number(tok[2]), Number(tok[3]));
  }
  return Float64Array.from(out);
}

/**
 * Load a `.obj` file into a `PointCloud` made of its mesh vertices.
 *
 * @param buffer Raw file bytes.
 * @param name   Display name (defaults to `"cloud.obj"`).
 */
export async function loadObj(buffer: ArrayBuffer, name = 'cloud.obj'): Promise<PointCloud> {
  const mesh = await parse(buffer, OBJLoader);

  const positionAttr = mesh.attributes.POSITION;
  if (!positionAttr) {
    throw new Error('OBJ file has no POSITION attribute');
  }

  // Stage in float64. The float64 `v` records are authoritative when they
  // ARE the point set (no faces, so the loader emitted nothing) or map 1:1
  // onto the loader's output; a de-indexed face mesh keeps the loader's
  // values widened (order and duplication differ from the `v` records).
  const meshPositions = positionAttr.value;
  const vertices = readVertexRecords(new TextDecoder().decode(buffer));
  const global =
    meshPositions.length === 0 || meshPositions.length === vertices.length
      ? vertices
      : Float64Array.from(meshPositions);

  // Recentre about a floored-min origin (float64 subtraction, then float32).
  // Non-finite coordinates are kept but excluded from the minimum.
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  for (let i = 0; i < global.length; i += 3) {
    if (global[i] < min[0]) min[0] = global[i];
    if (global[i + 1] < min[1]) min[1] = global[i + 1];
    if (global[i + 2] < min[2]) min[2] = global[i + 2];
  }
  const origin: [number, number, number] =
    Number.isFinite(min[0]) && Number.isFinite(min[1]) && Number.isFinite(min[2])
      ? computeOrigin(min)
      : [0, 0, 0];
  const positions = recenter(global, origin);

  return new PointCloud({
    positions,
    origin,
    sourceFormat: 'obj',
    name,
  });
}
