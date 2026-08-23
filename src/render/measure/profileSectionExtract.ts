/**
 * profileSectionExtract.ts
 *
 * Scan eligible sources for the returns inside a profile corridor.
 *
 * The derived sampler reads a concatenated copy of every loaded position.
 * A section keeps only the small fraction inside a corridor, so copying the
 * scene to find them would cost more memory than the answer. This walks each
 * source in place and appends accepted returns to a builder.
 *
 * A source is read through `readProjectXYZ`, which resolves the point in the
 * project frame at read time. Source buffers are never modified and never
 * copied wholesale, and the placement stays float64 so a mounted layer far
 * from the project origin keeps its precision.
 *
 * The scan is a generator. It yields the number of points examined so far
 * every `chunkSize` points, so a caller can spread it across frames or abort
 * it without this module knowing anything about the host's scheduler.
 */
import type { ProfileFrame } from './profileGeometry';
import {
  profileCorridorAccepts,
  createProfileHitScratch,
  PROFILE_HIT_CHAINAGE,
  PROFILE_HIT_LATERAL,
  PROFILE_HIT_HEIGHT,
} from './profileCorridor';
import {
  ProfileSectionBuilder,
  type ProfileSourceChannels,
  type ProfileSectionPoints,
} from './profileSectionBuilder';

/** An axis-aligned box in the project frame. */
export interface ProfileSourceBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * One source the scan may read.
 *
 * Structural rather than a concrete cloud type, so this module does not
 * import the viewer, the streaming scheduler or `PointCloud`.
 */
export interface ProfileSectionSourceView {
  /** Stable slot recorded on every return this source contributes. */
  readonly slot: number;
  readonly pointCount: number;
  /** Channels aligned to this source's own point index, or null. */
  readonly channels: ProfileSourceChannels | null;
  /**
   * Conservative project-frame bounds, or null when unknown.
   *
   * Null means the source is scanned. A box that does not contain every
   * point would drop returns silently, so an uncertain bound must be null.
   */
  readonly bounds: ProfileSourceBounds | null;
  /** Write the project-frame position of `index` into `out[0..2]`. */
  readProjectXYZ(index: number, out: Float64Array): void;
}

export interface ExtractProfileSectionOptions {
  readonly frame: ProfileFrame;
  /** Corridor half-width, in the same units as the frame. */
  readonly band: number;
  readonly sources: readonly ProfileSectionSourceView[];
  /** Points examined between yields. */
  readonly chunkSize?: number;
  /** Consulted at each yield point. */
  readonly signal?: { readonly aborted: boolean };
  /** Skip the bounds pre-test, for differential testing of that test. */
  readonly skipBoundsTest?: boolean;
}

export interface ProfileSectionExtractResult {
  readonly points: ProfileSectionPoints;
  /** True when the scan stopped early because the signal aborted. */
  readonly aborted: boolean;
  /** Slots skipped by the bounds pre-test. */
  readonly skippedSlots: readonly number[];
  /** Points examined, which excludes any source the bounds test skipped. */
  readonly examined: number;
}

const DEFAULT_CHUNK = 65536;

/**
 * Can any point in `bounds` fall inside the corridor?
 *
 * Chainage and lateral offset are affine in the point, so each attains its
 * extremes over a box at a corner. Comparing those extremes against the
 * corridor's own chainage and lateral limits rejects a box that cannot
 * contribute, and never rejects one that can. Height is unconstrained, so it
 * takes no part.
 *
 * This is a rejection test only. A box that passes may still hold no
 * accepted point, which costs a scan and not a wrong answer.
 */
export function boundsMayIntersectCorridor(
  frame: ProfileFrame,
  band: number,
  bounds: ProfileSourceBounds,
): boolean {
  const { min, max } = bounds;
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(min[i]!) || !Number.isFinite(max[i]!)) return true;
    if (min[i]! > max[i]!) return true;
  }
  let minChain = Infinity;
  let maxChain = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const u = frame.up;
  const aH = frame.horizontalAnchor;
  const along = frame.along;
  const lat = frame.lateral;
  for (let c = 0; c < 8; c++) {
    const px = (c & 1 ? max : min)[0]!;
    const py = (c & 2 ? max : min)[1]!;
    const pz = (c & 4 ? max : min)[2]!;
    const h = px * u[0] + py * u[1] + pz * u[2];
    const dx = px - u[0] * h - aH[0];
    const dy = py - u[1] * h - aH[1];
    const dz = pz - u[2] * h - aH[2];
    const s = dx * along[0] + dy * along[1] + dz * along[2];
    const d = dx * lat[0] + dy * lat[1] + dz * lat[2];
    if (s < minChain) minChain = s;
    if (s > maxChain) maxChain = s;
    if (d < minLat) minLat = d;
    if (d > maxLat) maxLat = d;
  }
  if (!Number.isFinite(minChain) || !Number.isFinite(minLat)) return true;
  const L = frame.horizontalLength;
  if (maxChain < -band) return false;
  if (minChain > L + band) return false;
  if (minLat > band) return false;
  if (maxLat < -band) return false;
  return true;
}

/**
 * Walk the sources, yielding the count examined so far every `chunkSize`
 * points, and return the accepted returns.
 *
 * Sources are read in the order supplied and each source in index order, so
 * the result does not depend on when any source became available.
 */
export function* extractProfileSectionChunks(
  opts: ExtractProfileSectionOptions,
): Generator<number, ProfileSectionExtractResult, void> {
  const { frame, band, sources } = opts;
  const chunk = opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : DEFAULT_CHUNK;
  const bandSq = band * band;
  const builder = new ProfileSectionBuilder();
  const scratch = createProfileHitScratch();
  const xyz = new Float64Array(3);
  const skipped: number[] = [];
  let examined = 0;
  let sinceYield = 0;
  let aborted = false;

  for (const src of sources) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    if (!opts.skipBoundsTest && src.bounds && !boundsMayIntersectCorridor(frame, band, src.bounds)) {
      skipped.push(src.slot);
      continue;
    }
    builder.beginSource(src.slot, src.channels, src.pointCount);
    for (let i = 0; i < src.pointCount; i++) {
      src.readProjectXYZ(i, xyz);
      if (profileCorridorAccepts(frame, band, bandSq, xyz[0]!, xyz[1]!, xyz[2]!, scratch)) {
        builder.push(
          i,
          scratch[PROFILE_HIT_CHAINAGE]!,
          scratch[PROFILE_HIT_HEIGHT]!,
          scratch[PROFILE_HIT_LATERAL]!,
        );
      }
      examined++;
      if (++sinceYield >= chunk) {
        sinceYield = 0;
        yield examined;
        if (opts.signal?.aborted) {
          aborted = true;
          break;
        }
      }
    }
    if (aborted) break;
  }

  return { points: builder.finish(), aborted, skippedSlots: skipped, examined };
}

/** Run {@link extractProfileSectionChunks} to completion. */
export function extractProfileSection(
  opts: ExtractProfileSectionOptions,
): ProfileSectionExtractResult {
  const it = extractProfileSectionChunks(opts);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value;
}
