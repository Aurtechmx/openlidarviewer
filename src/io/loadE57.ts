/**
 * loadE57.ts
 *
 * Adapts the from-scratch E57 parser (`io/e57/`) to a `PointCloud`. It merges
 * every scan in the file, applies each scan's pose, filters points flagged
 * invalid, and bridges global coordinates into the viewer's local space — the
 * same coordinate bridge the LAS loader uses, so an E57 behaves natively.
 *
 * Scope: the common real-world E57 files mainstream scanners produce —
 * Cartesian XYZ plus colour / intensity / classification / normals. Multi-scan
 * files merge into one cloud.
 */

import { parseE57 } from './e57/parseE57';
import type { E57ScanData } from './e57/parseE57';
import type { E57Metadata, E57Pose } from './e57/schema';
import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import { computeOrigin, recenter } from './coordinateBridge';

/** Clamp a value into the 0–255 byte range. */
function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Clamp a value into the 0–65535 uint16 range. */
function clampU16(v: number): number {
  return v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v);
}

/** Rotate a point by a quaternion `[w, x, y, z]`. */
function rotate(
  px: number,
  py: number,
  pz: number,
  q: [number, number, number, number],
): [number, number, number] {
  const [w, x, y, z] = q;
  // t = 2 · (q.xyz × p)
  const tx = 2 * (y * pz - z * py);
  const ty = 2 * (z * px - x * pz);
  const tz = 2 * (x * py - y * px);
  // p + w·t + (q.xyz × t)
  return [
    px + w * tx + (y * tz - z * ty),
    py + w * ty + (z * tx - x * tz),
    pz + w * tz + (x * ty - y * tx),
  ];
}

/** Count a scan's valid points (those not flagged by `cartesianInvalidState`). */
function countValid(scan: E57ScanData): number {
  const invalid = scan.columns.cartesianInvalidState;
  if (!invalid) return scan.recordCount;
  let valid = 0;
  for (let i = 0; i < scan.recordCount; i++) if (invalid[i] === 0) valid++;
  return valid;
}

/** Build provenance metadata from the E57 file metadata. */
function e57Metadata(meta: E57Metadata, scanCount: number): CloudMetadata | undefined {
  const out: CloudMetadata = {};
  if (meta.library) out.sourceSoftware = meta.library;
  if (scanCount > 1) out.captureSensor = `${scanCount} merged scans`;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Load an `.e57` file into a `PointCloud`. Every scan is merged; invalid
 * points are dropped; positions are recentred about a floored-min origin.
 */
export async function loadE57(buffer: ArrayBuffer, name = 'cloud.e57'): Promise<PointCloud> {
  const parsed = parseE57(buffer);
  const scans = parsed.scans;

  // An attribute is merged only when every scan provides it.
  const has = (field: string): boolean => scans.every((s) => s.columns[field] !== undefined);
  const hasColor = has('colorRed') && has('colorGreen') && has('colorBlue');
  const hasIntensity = has('intensity');
  const hasClassification = has('classification');
  const hasNormals = has('normalX') && has('normalY') && has('normalZ');

  let total = 0;
  for (const scan of scans) total += countValid(scan);
  if (total === 0) throw new Error('E57: the file contains no valid points.');

  const global = new Float64Array(total * 3);
  const colors = hasColor ? new Uint8Array(total * 3) : undefined;
  const intensity = hasIntensity ? new Uint16Array(total) : undefined;
  const classification = hasClassification ? new Uint8Array(total) : undefined;
  const normals = hasNormals ? new Float32Array(total * 3) : undefined;

  let w = 0; // running point index across all merged scans
  for (const scan of scans) {
    const col = scan.columns;
    const cx = col.cartesianX;
    const cy = col.cartesianY;
    const cz = col.cartesianZ;
    if (!cx || !cy || !cz) continue; // a scan with no XYZ data — nothing to merge
    const invalid = col.cartesianInvalidState;
    const pose: E57Pose | null = scan.pose;
    const colorScale = scan.colorMax && scan.colorMax > 0 ? 255 / scan.colorMax : 1;

    for (let i = 0; i < scan.recordCount; i++) {
      if (invalid && invalid[i] !== 0) continue;

      let px = cx[i];
      let py = cy[i];
      let pz = cz[i];
      if (pose) {
        const r = rotate(px, py, pz, pose.rotation);
        px = r[0] + pose.translation[0];
        py = r[1] + pose.translation[1];
        pz = r[2] + pose.translation[2];
      }
      global[w * 3] = px;
      global[w * 3 + 1] = py;
      global[w * 3 + 2] = pz;

      if (colors && col.colorRed && col.colorGreen && col.colorBlue) {
        colors[w * 3] = clampByte(col.colorRed[i] * colorScale);
        colors[w * 3 + 1] = clampByte(col.colorGreen[i] * colorScale);
        colors[w * 3 + 2] = clampByte(col.colorBlue[i] * colorScale);
      }
      if (intensity && col.intensity) intensity[w] = clampU16(col.intensity[i]);
      if (classification && col.classification) {
        classification[w] = clampByte(col.classification[i]);
      }
      if (normals && col.normalX && col.normalY && col.normalZ) {
        normals[w * 3] = col.normalX[i];
        normals[w * 3 + 1] = col.normalY[i];
        normals[w * 3 + 2] = col.normalZ[i];
      }
      w++;
    }
  }

  // Recenter about a floored-min origin (float64 subtraction, then float32).
  const min = [Infinity, Infinity, Infinity];
  for (let i = 0; i < global.length; i += 3) {
    if (global[i] < min[0]) min[0] = global[i];
    if (global[i + 1] < min[1]) min[1] = global[i + 1];
    if (global[i + 2] < min[2]) min[2] = global[i + 2];
  }
  const origin = computeOrigin(min);

  return new PointCloud({
    positions: recenter(global, origin),
    colors,
    intensity,
    classification,
    normals,
    origin,
    sourceFormat: 'e57',
    name,
    declaredPointCount: total,
    decodedPointCount: total,
    metadata: e57Metadata(parsed.metadata, scans.length),
  });
}
