/**
 * OBJ loader.
 *
 * Reads a Wavefront OBJ mesh with `@loaders.gl/obj` and treats its vertex
 * positions as a point set. OBJ files carry local coordinates, so the origin
 * is the zero vector.
 */

import { parse } from '@loaders.gl/core';
import { OBJLoader } from '@loaders.gl/obj';
import { PointCloud } from '../model/PointCloud';

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

  // Copy into a fresh buffer the PointCloud owns.
  const positions = new Float32Array(positionAttr.value);

  return new PointCloud({
    positions,
    origin: [0, 0, 0],
    sourceFormat: 'obj',
    name,
  });
}
