/**
 * PLY loader.
 *
 * Reads a Polygon File Format point cloud with `@loaders.gl/ply`. PLY clouds
 * can carry global survey coordinates — this app's own exporter writes them —
 * so positions are staged in float64 and recentred through the coordinate
 * bridge before the float32 downcast, like every other text loader.
 *
 * loaders.gl narrows every property to float32 during normalisation, which
 * would quantise a UTM northing onto a ~0.25 m grid before recentring could
 * save it. For an ASCII body the vertex x/y/z are therefore re-read from the
 * text at full float64 precision; a binary body keeps the loader's values
 * (float32-sourced files carry that precision in the file itself; binary
 * `double` properties are narrowed by the loader — a known limitation).
 */

import { parse } from '@loaders.gl/core';
import { PLYLoader } from '@loaders.gl/ply';
import { PointCloud } from '../model/PointCloud';
import { computeOrigin, recenter } from './coordinateBridge';

/** The slice of the loaders.gl PLY header this loader relies on. */
interface PlyHeaderData {
  format?: string;
  headerLength?: number;
  elements?: Array<{
    name: string;
    count: number;
    properties: Array<{ type: string; name: string }>;
  }>;
}

/**
 * Re-read vertex x/y/z from an ASCII PLY body in float64. Returns `null`
 * when the layout rules out a safe re-read — binary body, vertex element
 * not declared first, a list property making the token stride variable, or
 * a token count that does not cover the declared vertices — in which case
 * the caller falls back to the loader's float32 values.
 */
function readAsciiVertices(
  buffer: ArrayBuffer,
  header: PlyHeaderData | undefined,
  expectedCount: number,
): Float64Array | null {
  if (header?.format !== 'ascii') return null;
  if (typeof header.headerLength !== 'number' || header.headerLength <= 0) return null;
  const vertex = header.elements?.[0];
  if (!vertex || vertex.name !== 'vertex' || vertex.count !== expectedCount) return null;
  const props = vertex.properties;
  if (props.some((p) => p.type === 'list')) return null;
  const xi = props.findIndex((p) => p.name === 'x');
  const yi = props.findIndex((p) => p.name === 'y');
  const zi = props.findIndex((p) => p.name === 'z');
  if (xi < 0 || yi < 0 || zi < 0) return null;

  // `headerLength` is measured on the decoded text (the loader decodes the
  // whole buffer the same way), so slicing there lands exactly on the body.
  const body = new TextDecoder().decode(buffer).slice(header.headerLength);
  const stride = props.length;
  const tokens = body.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < expectedCount * stride) return null;

  const out = new Float64Array(expectedCount * 3);
  for (let i = 0; i < expectedCount; i++) {
    out[i * 3] = Number(tokens[i * stride + xi]);
    out[i * 3 + 1] = Number(tokens[i * stride + yi]);
    out[i * 3 + 2] = Number(tokens[i * stride + zi]);
  }
  return out;
}

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

  const pointCount = positionAttr.value.length / 3;
  // Stage in float64: the ASCII re-read where possible, otherwise the
  // loader's values widened (their float32 precision is all the file kept).
  const global =
    positionAttr.value instanceof Float64Array
      ? positionAttr.value
      : (readAsciiVertices(buffer, mesh.loaderData as PlyHeaderData | undefined, pointCount) ??
        Float64Array.from(positionAttr.value));

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

  // COLOR_0 is optional. PLY commonly stores rgb (size 3) or rgba (size 4);
  // keep only the three colour channels regardless.
  let colors: Uint8Array | undefined;
  const colorAttr = attributes.COLOR_0;
  if (colorAttr) {
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
    origin,
    sourceFormat: 'ply',
    name,
  });
}
