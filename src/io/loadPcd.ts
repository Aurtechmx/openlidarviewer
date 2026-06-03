/**
 * loadPcd.ts
 *
 * PCD (Point Cloud Data) loader. PCD has three body encodings — `ascii`,
 * `binary`, and `binary_compressed` (the last LZF-compressed). Rather than
 * re-implement the LZF decompressor, decoding is delegated to three.js's vetted
 * `PCDLoader`; this module adapts its output into the viewer's `PointCloud` —
 * recentred through the coordinate bridge, with attributes normalised to the
 * viewer's typed-array conventions.
 *
 * `PCDLoader.parse` builds only data (no DOM), so this runs in the parse worker.
 */

import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { PointCloud } from '../model/PointCloud';
import { computeOrigin } from './coordinateBridge';

/** Round and clamp a value into the 0–255 byte range. */
function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Round and clamp a value into the 0–65535 Uint16 range. */
function clampU16(v: number): number {
  return v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v);
}

/**
 * Load a `.pcd` point cloud into a `PointCloud`.
 *
 * @param buffer Raw file bytes.
 * @param name   Display name (defaults to `"cloud.pcd"`).
 */
export async function loadPcd(buffer: ArrayBuffer, name = 'cloud.pcd'): Promise<PointCloud> {
  let points;
  try {
    points = new PCDLoader().parse(buffer);
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : '';
    throw new Error(`This PCD file could not be read${detail}`);
  }
  const geometry = points.geometry;

  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count === 0) {
    throw new Error('PCD file has no readable points');
  }
  const count = posAttr.count;

  // Recentre via the coordinate bridge so the renderer's origin contract holds.
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
  }
  const origin = computeOrigin(min);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = posAttr.getX(i) - origin[0];
    positions[i * 3 + 1] = posAttr.getY(i) - origin[1];
    positions[i * 3 + 2] = posAttr.getZ(i) - origin[2];
  }

  // Colour — PCDLoader yields 0–1 floats; the viewer stores 0–255 bytes.
  let colors: Uint8Array | undefined;
  const colorAttr = geometry.getAttribute('color');
  if (colorAttr) {
    colors = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = clampByte(colorAttr.getX(i) * 255);
      colors[i * 3 + 1] = clampByte(colorAttr.getY(i) * 255);
      colors[i * 3 + 2] = clampByte(colorAttr.getZ(i) * 255);
    }
  }

  // Normals — carried through unchanged when the file provides them.
  let normals: Float32Array | undefined;
  const normalAttr = geometry.getAttribute('normal');
  if (normalAttr) {
    normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      normals[i * 3] = normalAttr.getX(i);
      normals[i * 3 + 1] = normalAttr.getY(i);
      normals[i * 3 + 2] = normalAttr.getZ(i);
    }
  }

  // Intensity — PCD intensity is a float of no fixed range. The viewer stores
  // a Uint16: a 0–1 file is rescaled to the full range so the colour ramp and
  // the inspector stay meaningful; a larger range is taken as a raw value.
  let intensity: Uint16Array | undefined;
  const intensityAttr = geometry.getAttribute('intensity');
  if (intensityAttr) {
    let maxI = 0;
    for (let i = 0; i < count; i++) maxI = Math.max(maxI, intensityAttr.getX(i));
    const scale = maxI > 0 && maxI <= 1 ? 65535 : 1;
    intensity = new Uint16Array(count);
    for (let i = 0; i < count; i++) intensity[i] = clampU16(intensityAttr.getX(i) * scale);
  }

  // Labels — PCD's per-point label maps to the classification slot.
  let classification: Uint8Array | undefined;
  const labelAttr = geometry.getAttribute('label');
  if (labelAttr) {
    classification = new Uint8Array(count);
    for (let i = 0; i < count; i++) classification[i] = clampByte(labelAttr.getX(i));
  }

  return new PointCloud({
    positions,
    colors,
    intensity,
    classification,
    normals,
    origin,
    sourceFormat: 'pcd',
    name,
    decodedPointCount: count,
  });
}
