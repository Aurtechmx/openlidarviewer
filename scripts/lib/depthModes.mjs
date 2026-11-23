/**
 * depthModes.mjs: the depth resolution each depth-buffer scheme can store,
 * for the depth-mode benchmark (scripts/bench-depth-mode.mjs).
 *
 * "Resolution at d" is the smallest change in eye distance that changes the
 * stored depth value at distance d: two surfaces closer than that share one
 * depth and z-fight. Storage only: the float32 vertex pipeline adds its own
 * rounding (about d x 6e-8) on top of every scheme.
 *
 *   standard   perspective depth, 24-bit normalised
 *   log        three.js node pipeline: log2(d/n) / log2(f/n), 24-bit normalised
 *   reversed   perspective depth with near at 1 and far at 0, 32-bit float
 */

export const DEPTH_MODES = ['standard', 'log', 'reversed'];

const UNORM24 = 2 ** -24;

/** The spacing of float32 values around v. */
export function float32Ulp(v) {
  const a = Math.abs(v);
  if (a === 0) return 2 ** -149;
  return 2 ** (Math.max(Math.floor(Math.log2(a)), -126) - 23);
}

/** Stored depth for a point at eye distance d. */
export function storedDepth(mode, d, near, far) {
  if (mode === 'log') return Math.log2(d / near) / Math.log2(far / near);
  if (mode === 'reversed') return (near * (far - d)) / (d * (far - near));
  return (far * (d - near)) / (d * (far - near));
}

/** Smallest eye-distance step the stored depth can tell apart at distance d. */
export function depthResolution(mode, d, near, far) {
  if (mode === 'log') return d * Math.log(far / near) * UNORM24;
  if (mode === 'reversed') {
    const v = storedDepth('reversed', d, near, far);
    return (float32Ulp(v) * d * d * (far - near)) / (near * far);
  }
  return (UNORM24 * d * d * (far - near)) / (near * far);
}

/** A table of resolutions for the distances a survey spans. */
export function resolutionTable(near, far, distances = [1, 10, 100, 1000, 10_000, 50_000]) {
  return distances.map((d) => ({
    d,
    ...Object.fromEntries(DEPTH_MODES.map((m) => [m, depthResolution(m, d, near, far)])),
  }));
}

/** Median and 95th percentile of frame times. */
export function summariseFrames(times) {
  const s = [...times].sort((a, b) => a - b);
  if (s.length === 0) return { medianMs: null, p95Ms: null, frames: 0 };
  return { medianMs: s[s.length >> 1], p95Ms: s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)], frames: s.length };
}
