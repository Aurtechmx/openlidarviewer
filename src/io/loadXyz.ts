/**
 * XYZ / CSV loader.
 *
 * Reads a plain-text point cloud: one point per line, columns separated by
 * whitespace or commas. The first three columns are x, y, z; if the first
 * data line carries six or more columns the next three are taken as r, g, b.
 *
 * Comment lines (starting with `#`) and a non-numeric header row are skipped.
 * Coordinates may be large (survey eastings/northings), so the same float64
 * coordinate bridge used for LAS is applied here.
 */

import { PointCloud } from '../model/PointCloud';
import { computeOrigin, recenter } from './coordinateBridge';

/** Split a line into tokens on any run of whitespace or commas. */
function tokenize(line: string): string[] {
  return line.split(/[\s,]+/).filter((t) => t.length > 0);
}

/**
 * Load a `.xyz` / `.csv` point cloud into a `PointCloud`.
 *
 * @param buffer Raw file bytes.
 * @param name   Display name (defaults to `"cloud.xyz"`).
 */
export async function loadXyz(buffer: ArrayBuffer, name = 'cloud.xyz'): Promise<PointCloud> {
  const text = new TextDecoder().decode(buffer);
  const lines = text.split(/\r?\n/);

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const rgb: number[] = [];
  // `null` until the first data line decides whether the file carries colour.
  let hasColor: boolean | null = null;
  let colorMax = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line[0] === '#') continue;

    const tok = tokenize(line);
    const x = Number(tok[0]);
    const y = Number(tok[1]);
    const z = Number(tok[2]);
    // A non-numeric line (e.g. a "x,y,z" header) is silently skipped.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    if (hasColor === null) {
      hasColor = tok.length >= 6
        && Number.isFinite(Number(tok[3]))
        && Number.isFinite(Number(tok[4]))
        && Number.isFinite(Number(tok[5]));
    }

    xs.push(x);
    ys.push(y);
    zs.push(z);
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;

    if (hasColor) {
      const r = Number(tok[3]);
      const g = Number(tok[4]);
      const b = Number(tok[5]);
      const rr = Number.isFinite(r) ? r : 0;
      const gg = Number.isFinite(g) ? g : 0;
      const bb = Number.isFinite(b) ? b : 0;
      rgb.push(rr, gg, bb);
      colorMax = Math.max(colorMax, rr, gg, bb);
    }
  }

  const count = xs.length;
  if (count === 0) throw new Error('XYZ file has no readable points');

  // Recentre via the float64 coordinate bridge so large survey coordinates
  // keep sub-metre precision.
  const global = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    global[i * 3] = xs[i];
    global[i * 3 + 1] = ys[i];
    global[i * 3 + 2] = zs[i];
  }
  const origin = computeOrigin(min);
  const positions = recenter(global, origin);

  let colors: Uint8Array | undefined;
  if (hasColor) {
    // If every channel is ≤ 1 the file uses 0–1 floats; otherwise 0–255.
    const normalized = colorMax <= 1;
    colors = new Uint8Array(count * 3);
    for (let i = 0; i < count * 3; i++) {
      const v = normalized ? rgb[i] * 255 : rgb[i];
      colors[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }

  return new PointCloud({
    positions,
    colors,
    origin,
    sourceFormat: 'xyz',
    name,
    decodedPointCount: count,
  });
}
