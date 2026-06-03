/**
 * PLY loader.
 *
 * Reads a Polygon File Format point cloud with `@loaders.gl/ply`. PLY clouds
 * are assumed to already be in local coordinates, so the origin is the zero
 * vector — no recentering is needed.
 */

import { parse } from '@loaders.gl/core';
import { PLYLoader } from '@loaders.gl/ply';
import { PointCloud } from '../model/PointCloud';

/**
 * Load a `.ply` point cloud into a `PointCloud`.
 *
 * @param buffer Raw file bytes.
 * @param name   Display name (defaults to `"cloud.ply"`).
 */
export async function loadPly(buffer: ArrayBuffer, name = 'cloud.ply'): Promise<PointCloud> {
  const mesh = await parse(buffer, PLYLoader);
  const attributes = mesh.attributes;

  const positionAttr = attributes.POSITION;
  if (!positionAttr) {
    throw new Error('PLY file has no POSITION attribute');
  }

  // loaders.gl already hands back interleaved xyz; copy into a fresh
  // Float32Array so the PointCloud owns its buffer outright.
  const positions = new Float32Array(positionAttr.value);

  // COLOR_0 is optional. PLY commonly stores rgb (size 3) or rgba (size 4);
  // keep only the three colour channels regardless.
  let colors: Uint8Array | undefined;
  const colorAttr = attributes.COLOR_0;
  if (colorAttr) {
    const pointCount = positions.length / 3;
    const componentsPerVertex = colorAttr.size ?? 3;
    const src = colorAttr.value;
    colors = new Uint8Array(pointCount * 3);
    for (let i = 0; i < pointCount; i++) {
      colors[i * 3 + 0] = src[i * componentsPerVertex + 0];
      colors[i * 3 + 1] = src[i * componentsPerVertex + 1];
      colors[i * 3 + 2] = src[i * componentsPerVertex + 2];
    }
  }

  return new PointCloud({
    positions,
    colors,
    origin: [0, 0, 0],
    sourceFormat: 'ply',
    name,
  });
}
