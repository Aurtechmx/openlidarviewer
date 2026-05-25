/**
 * loadPts.ts
 *
 * PTS loader. A PTS file is an optional point-count line followed by point
 * lines. The column layout is one of the four standard PTS variants, detected
 * from the first data line:
 *
 *   x y z                  (3)
 *   x y z intensity        (4)
 *   x y z r g b            (6)
 *   x y z intensity r g b  (7)
 *
 * Note the column order — PTS puts intensity *before* RGB. Malformed lines are
 * tolerated and skipped. Coordinates may be survey-scale, so the float64
 * coordinate bridge recentres them.
 *
 * The file is streamed line-by-line through {@link readTextLines}, so a very
 * large PTS stays within a bounded memory footprint.
 *
 * Pure (no DOM, no three.js) — runs in the parse worker.
 */

import { PointCloud } from '../model/PointCloud';
import { computeOrigin, recenter } from './coordinateBridge';
import { readTextLines } from './textChunkReader';
import type { ProgressUpdate } from './loadProgress';

/** Split a line into tokens on any run of whitespace. */
function tokenize(line: string): string[] {
  return line.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Load a `.pts` point cloud into a `PointCloud`.
 *
 * @param buffer     Raw file bytes.
 * @param name       Display name (defaults to `"cloud.pts"`).
 * @param onProgress Optional staged-progress callback for the chunked decode.
 */
export async function loadPts(
  buffer: ArrayBuffer,
  name = 'cloud.pts',
  onProgress?: (u: ProgressUpdate) => void,
): Promise<PointCloud> {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const intensityVals: number[] = [];
  const rgb: number[] = [];
  // The column layout, fixed from the first data line.
  let hasIntensity = false;
  let hasColor = false;
  let layoutDecided = false;
  let colorIndex = 3;
  let colorMax = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  // PTS may begin with a lone integer point-count line; it is skipped once.
  let countLineConsumed = false;

  readTextLines(
    buffer,
    (raw) => {
      const line = raw.trim();
      if (line === '' || line[0] === '#') return;

      const tok = tokenize(line);
      // The optional first line is a lone non-negative integer — the point
      // count. It is informational; the actual points are counted as decoded.
      if (!countLineConsumed && tok.length === 1 && /^\d+$/.test(tok[0])) {
        countLineConsumed = true;
        return;
      }
      countLineConsumed = true;

      const x = Number(tok[0]);
      const y = Number(tok[1]);
      const z = Number(tok[2]);
      // A non-numeric line (a stray header, a comment without `#`) is skipped.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

      if (!layoutDecided) {
        layoutDecided = true;
        const cols = tok.length;
        hasIntensity = cols === 4 || cols >= 7;
        hasColor = cols === 6 || cols >= 7;
        colorIndex = hasIntensity ? 4 : 3;
      }

      xs.push(x);
      ys.push(y);
      zs.push(z);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;

      if (hasIntensity) {
        const it = Number(tok[3]);
        intensityVals.push(Number.isFinite(it) ? it : 0);
      }
      if (hasColor) {
        const r = Number(tok[colorIndex]);
        const g = Number(tok[colorIndex + 1]);
        const b = Number(tok[colorIndex + 2]);
        const rr = Number.isFinite(r) ? r : 0;
        const gg = Number.isFinite(g) ? g : 0;
        const bb = Number.isFinite(b) ? b : 0;
        rgb.push(rr, gg, bb);
        colorMax = Math.max(colorMax, rr, gg, bb);
      }
    },
    {
      onProgress: onProgress
        ? (fraction) => onProgress({ stage: 'decoding', fraction })
        : undefined,
    },
  );

  const count = xs.length;
  if (count === 0) throw new Error('PTS file has no readable points');

  // Recentre via the float64 coordinate bridge so survey-scale coordinates
  // keep sub-metre precision.
  const global = new Float64Array(count * 3);
  for (let p = 0; p < count; p++) {
    global[p * 3] = xs[p];
    global[p * 3 + 1] = ys[p];
    global[p * 3 + 2] = zs[p];
  }
  const origin = computeOrigin(min);
  const positions = recenter(global, origin);

  // Intensity — PTS intensity has no fixed range and can be signed (some
  // scanners write −2048…2047). Shift any negative range up to start at 0,
  // then rescale a 0–1 range to the full Uint16 span; a wider range is taken
  // as a raw value. This keeps both the colour ramp and the inspector honest.
  let intensity: Uint16Array | undefined;
  if (hasIntensity) {
    let iMin = Infinity;
    let iMax = -Infinity;
    for (const v of intensityVals) {
      if (v < iMin) iMin = v;
      if (v > iMax) iMax = v;
    }
    const offset = iMin < 0 ? -iMin : 0;
    const range = iMax + offset;
    const scale = range > 0 && range <= 1 ? 65535 : 1;
    intensity = new Uint16Array(count);
    for (let p = 0; p < count; p++) {
      const v = Math.round((intensityVals[p] + offset) * scale);
      intensity[p] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    }
  }

  // Colour — 0–1 floats or 0–255 bytes, decided by the observed maximum.
  let colors: Uint8Array | undefined;
  if (hasColor) {
    const normalized = colorMax <= 1;
    colors = new Uint8Array(count * 3);
    for (let k = 0; k < count * 3; k++) {
      const v = Math.round(normalized ? rgb[k] * 255 : rgb[k]);
      colors[k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  return new PointCloud({
    positions,
    colors,
    intensity,
    origin,
    sourceFormat: 'pts',
    name,
    decodedPointCount: count,
  });
}
