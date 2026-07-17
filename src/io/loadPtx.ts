/**
 * loadPtx.ts
 *
 * PTX loader. A PTX file is one or more blocks ("clouds"), each a terrestrial
 * laser scan: a 10-line header — grid dimensions, the scanner pose, and a 4×4
 * registration transform — followed by `cols × rows` point lines
 * (`x y z intensity [r g b]`) in the scanner's local frame.
 *
 * Each block's points are transformed to world coordinates by its own 4×4
 * matrix, so a multi-block PTX registers into one consistent cloud. Empty grid
 * cells (a `0 0 0` line — a non-return) are skipped. A malformed block stops
 * further block parsing but never discards the blocks already read.
 *
 * Pure (no DOM, no three.js) — runs in the parse worker.
 */

import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import { sanitizeAndRecenter, withLoadWarning } from './sanitizeCloud';

/** A parsed 4×4 PTX transform — four rows of four numbers. */
type Mat4 = [number[], number[], number[], number[]];

/** The 4×4 identity — the fallback transform for a block with a bad matrix. */
const IDENTITY: Mat4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

/** The PTX header is two count lines, four pose lines, then four matrix lines. */
const HEADER_LINES = 10;

/** Split a line into tokens on any run of whitespace. */
function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Parse a matrix line into four floats. Non-finite or missing entries
 * are preserved as `NaN` so the caller can detect a malformed
 * transform — substituting `0` here would defeat `matrixIsFinite` and
 * silently apply a partially-zeroed transform that collapses or
 * mislocates the scan.
 */
function parseRow4(line: string | undefined): number[] {
  const tok = tokenize(line ?? '');
  const row = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  for (let i = 0; i < 4; i++) {
    row[i] = Number(tok[i]);
  }
  return row;
}

/** Whether every entry of a parsed transform is finite. */
function matrixIsFinite(m: Mat4): boolean {
  return m.every((row) => row.length === 4 && row.every((v) => Number.isFinite(v)));
}

/**
 * Load a `.ptx` point cloud into a `PointCloud`.
 *
 * @param buffer Raw file bytes.
 * @param name   Display name (defaults to `"cloud.ptx"`).
 */
export async function loadPtx(buffer: ArrayBuffer, name = 'cloud.ptx'): Promise<PointCloud> {
  const lines = new TextDecoder().decode(buffer).split(/\r?\n/);

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const intensityVals: number[] = [];
  const rgb: number[] = [];
  // `null` until the first point decides whether the file carries colour.
  let hasColor: boolean | null = null;
  let scannerOrigin: [number, number, number] | undefined;

  let i = 0;
  while (i < lines.length) {
    // Skip blank lines between blocks and any trailing newline.
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;

    // Block header — columns and rows.
    const cols = Number(tokenize(lines[i])[0]);
    const rows = Number(tokenize(lines[i + 1] ?? '')[0]);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 0 || rows < 0) {
      break; // not a valid block header — stop, keeping the blocks already read
    }
    if (i + HEADER_LINES > lines.length) break; // truncated header

    // The 4×4 transform sits in header lines 7–10 (after the two count lines
    // and four pose lines). PTX stores it row-major with translation in row 4.
    const parsed: Mat4 = [
      parseRow4(lines[i + 6]),
      parseRow4(lines[i + 7]),
      parseRow4(lines[i + 8]),
      parseRow4(lines[i + 9]),
    ];
    const m = matrixIsFinite(parsed) ? parsed : IDENTITY;
    if (!scannerOrigin) {
      // The transform's 4th row is the scanner's registered world position.
      scannerOrigin = [m[3][0], m[3][1], m[3][2]];
    }
    i += HEADER_LINES;

    const total = cols * rows;
    for (let p = 0; p < total && i < lines.length; p++, i++) {
      const tok = tokenize(lines[i]);
      if (tok.length < 4) continue; // malformed point line — skip it
      const lx = Number(tok[0]);
      const ly = Number(tok[1]);
      const lz = Number(tok[2]);
      if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) continue;
      // A 0 0 0 sample marks an empty grid cell (no laser return) — not a point.
      if (lx === 0 && ly === 0 && lz === 0) continue;

      // world = [x y z 1] · M — points are row vectors in the scanner frame.
      const wx = lx * m[0][0] + ly * m[1][0] + lz * m[2][0] + m[3][0];
      const wy = lx * m[0][1] + ly * m[1][1] + lz * m[2][1] + m[3][1];
      const wz = lx * m[0][2] + ly * m[1][2] + lz * m[2][2] + m[3][2];

      xs.push(wx);
      ys.push(wy);
      zs.push(wz);

      const it = Number(tok[3]);
      intensityVals.push(Number.isFinite(it) ? it : 0);

      if (hasColor === null) hasColor = tok.length >= 7;
      if (hasColor) {
        rgb.push(Number(tok[4]) || 0, Number(tok[5]) || 0, Number(tok[6]) || 0);
      }
    }
  }

  const count = xs.length;
  if (count === 0) throw new Error('PTX file has no readable points');

  // Recentre the world coordinates through the float64 coordinate bridge.
  const global = new Float64Array(count * 3);
  for (let p = 0; p < count; p++) {
    global[p * 3] = xs[p];
    global[p * 3 + 1] = ys[p];
    global[p * 3 + 2] = zs[p];
  }

  // Intensity — PTX intensity is conventionally a 0–1 float; that range is
  // rescaled to the full Uint16 span, otherwise it is taken as a raw value.
  let maxI = 0;
  for (const v of intensityVals) maxI = Math.max(maxI, v);
  const scale = maxI > 0 && maxI <= 1 ? 65535 : 1;
  const intensity = new Uint16Array(count);
  for (let p = 0; p < count; p++) {
    const v = Math.round(intensityVals[p] * scale);
    intensity[p] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  }

  // Colour — PTX RGB, when present, is 0–255 per channel.
  let colors: Uint8Array | undefined;
  if (hasColor) {
    colors = new Uint8Array(count * 3);
    for (let k = 0; k < count * 3; k++) {
      const v = Math.round(rgb[k]);
      colors[k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  // Release the JS number[] accumulators now that the typed positions /
  // intensity / colour outputs are built — the same memory-spike trim loadXyz
  // does, so a large PTX scan doesn't hold the boxed-number arrays alongside
  // the typed buffers (a transient 2–3× heap peak otherwise).
  xs.length = 0; ys.length = 0; zs.length = 0;
  intensityVals.length = 0; rgb.length = 0;

  const metadata: CloudMetadata | undefined = scannerOrigin ? { scannerOrigin } : undefined;

  // The point reader already refuses a non-numeric x/y/z, but the registration
  // transform is applied after that check, so this is where a world coordinate
  // that overflowed the block's matrix is caught — and where the survivors get
  // their floored-min origin.
  const clean = sanitizeAndRecenter(global, { colors, intensity });

  return new PointCloud({
    positions: clean.positions,
    colors: clean.attributes.colors,
    intensity: clean.attributes.intensity,
    origin: clean.origin,
    sourceFormat: 'ptx',
    name,
    decodedPointCount: count,
    metadata: withLoadWarning(metadata, clean.warning),
  });
}
