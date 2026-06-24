/**
 * sampleGrade.ts
 *
 * The {@link GradeFn} the full-cloud B-trigger runs over the decoded octree
 * sample. The runner ({@link runFullCloudGrade}) decodes a breadth-first
 * sampling plan into one local-space XYZ buffer and a `samplePointScale`; this
 * module turns that buffer into a representative, HONEST grade of the WHOLE
 * cloud — the thing the streaming "preview" can't give because the preview only
 * ever sees the view-driven resident nodes.
 *
 * What decoding adds over the header's point-count ÷ bbox estimate:
 *   • OCCUPANCY — a coarse XY occupancy grid reveals how much of the bounding
 *     box the cloud actually fills. A count ÷ bbox density silently assumes the
 *     footprint is a filled rectangle; an L-shaped corridor or a doughnut reads
 *     far denser than it is. Occupancy gives a truer areal density (points per
 *     OCCUPIED m², not per bbox m²) and a uniformity ratio.
 *   • VERTICAL EXTENT — the real min/max Z of the sample, for a height-span read
 *     the header's nominal bounds (which can be padded) doesn't guarantee.
 *
 * The density TIER reuses {@link classifyDensity} (points per cubic metre, the
 * app's existing convention) so a streaming grade and a static grade speak the
 * same language. The back-scale (`samplePointScale`, ≥ 1) lifts the sample's
 * density to the whole cloud, exactly as the preview scales a strided gather.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic. The honesty label
 * (exhaustive vs sampled, coverage %) is the runner's `coverage`, kept separate
 * so this module only owns the geometry.
 *
 * UNIT NOTE: positions are in the source CRS's linear unit. `metresPerUnit`
 * converts spans to metres so the densities read in SI; it defaults to 1
 * (the common projected-metres case). The classifyDensity bands are
 * deliberately wide, so a modest unit error shifts a number, not a verdict.
 */

import {
  classifyDensity,
  densityLabel,
  type DensityBucket,
} from '../../terrain/datasetIntelligence';

/** The geometric grade of a decoded full-cloud sample. */
export interface SampleGrade {
  /** XYZ points actually decoded and graded. */
  readonly sampledPoints: number;
  /** Whole-cloud estimate = sampledPoints × samplePointScale, rounded. */
  readonly estimatedTotalPoints: number;
  /** Bounding-box volume of the sample, in m³ (0 when degenerate). */
  readonly bboxVolumeM3: number;
  /** Vertical extent of the sample, in metres (maxZ − minZ). */
  readonly verticalSpanM: number;
  /**
   * Occupancy-aware areal density: estimated whole-cloud points per OCCUPIED
   * square metre (not per bbox m²), or null when it can't be derived. This is
   * the field-relevant "points per m²" a surveyor expects.
   */
  readonly arealDensityPerM2: number | null;
  /**
   * Fraction of the coarse XY grid the sample occupies, in [0,1]. Near 1 ⇒ the
   * cloud fills its bounding box; low ⇒ an irregular or hollow footprint whose
   * bbox overstates coverage. null when too few points to judge.
   */
  readonly occupancyRatio: number | null;
  /** Density tier (per-m³, via {@link classifyDensity}); 'unknown' when undecidable. */
  readonly bucket: DensityBucket;
  /** Human label for {@link bucket} ("Sparse" … "Very Dense", or "—"). */
  readonly bucketLabel: string;
}

/** Minimum points before an occupancy ratio is meaningful rather than noise. */
const MIN_POINTS_FOR_OCCUPANCY = 256;

/**
 * Grade a decoded full-cloud sample. Matches {@link GradeFn}'s
 * `(positions, samplePointScale) => G` shape so it drops straight into
 * {@link runFullCloudGrade} / {@link gradeFullCloud}.
 *
 * Defensive by construction: an empty or 1-point sample, a zero-volume bbox, or
 * a non-finite scale yields an honest 'unknown' grade with finite fields — never
 * a NaN/Infinity that would read as a confident-but-wrong number.
 */
export function gradeSampleDensity(
  positions: Float32Array,
  samplePointScale: number,
  metresPerUnit = 1,
): SampleGrade {
  const n = Math.floor(positions.length / 3);
  const scale = Number.isFinite(samplePointScale) && samplePointScale >= 1 ? samplePointScale : 1;
  const mpu = Number.isFinite(metresPerUnit) && metresPerUnit > 0 ? metresPerUnit : 1;

  const empty: SampleGrade = {
    sampledPoints: n,
    estimatedTotalPoints: Math.round(n * scale),
    bboxVolumeM3: 0,
    verticalSpanM: 0,
    arealDensityPerM2: null,
    occupancyRatio: null,
    bucket: 'unknown',
    bucketLabel: densityLabel('unknown'),
  };
  if (n < 1) return empty;

  // ── One pass for the AABB ──
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return empty;

  const spanX = Math.max(0, (maxX - minX)) * mpu;
  const spanY = Math.max(0, (maxY - minY)) * mpu;
  const spanZ = Math.max(0, (maxZ - minZ)) * mpu;
  const bboxVolumeM3 = spanX * spanY * spanZ;
  const estimatedTotalPoints = Math.round(n * scale);

  // ── Density tier (points per cubic metre, the app's convention) ──
  // Back-scaled: the whole cloud's ~n·scale points span ~the same bbox a
  // breadth-first sample covers, so its per-volume density ≈ sample × scale.
  const bucket =
    bboxVolumeM3 > 0
      ? classifyDensity({ residentDensity: (n * scale) / bboxVolumeM3 })
      : 'unknown';

  // ── Occupancy-aware areal density + uniformity ──
  // A coarse XY grid sized so a uniform sample averages ~4 points/cell, which
  // keeps the occupied-cell count meaningful (not "every cell hit" or "almost
  // none"). Below a floor we don't claim an occupancy figure at all.
  let occupancyRatio: number | null = null;
  let arealDensityPerM2: number | null = null;
  if (n >= MIN_POINTS_FOR_OCCUPANCY && spanX > 0 && spanY > 0) {
    const cellsPerAxis = clampInt(Math.round(Math.sqrt(n / 4)), 8, 96);
    const occupied = new Uint8Array(cellsPerAxis * cellsPerAxis);
    const rangeX = maxX - minX, rangeY = maxY - minY;
    let occupiedCount = 0;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      // Clamp the max edge into the last cell rather than overflowing.
      const gx = Math.min(cellsPerAxis - 1, Math.floor(((x - minX) / rangeX) * cellsPerAxis));
      const gy = Math.min(cellsPerAxis - 1, Math.floor(((y - minY) / rangeY) * cellsPerAxis));
      const idx = gy * cellsPerAxis + gx;
      if (occupied[idx] === 0) { occupied[idx] = 1; occupiedCount++; }
    }
    occupancyRatio = occupiedCount / (cellsPerAxis * cellsPerAxis);
    const cellAreaM2 = (rangeX * mpu / cellsPerAxis) * (rangeY * mpu / cellsPerAxis);
    const occupiedAreaM2 = occupiedCount * cellAreaM2;
    if (occupiedAreaM2 > 0) arealDensityPerM2 = (n * scale) / occupiedAreaM2;
  }

  return {
    sampledPoints: n,
    estimatedTotalPoints,
    bboxVolumeM3,
    verticalSpanM: spanZ,
    arealDensityPerM2,
    occupancyRatio,
    bucket,
    bucketLabel: densityLabel(bucket),
  };
}

/** Round to an integer and clamp into [lo, hi]. */
function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * A short, honest human summary of a {@link SampleGrade} for the panel. Pairs
 * with the runner's coverage label (passed separately) so the density figures
 * always travel with their "exact vs sampled" context.
 */
export function summarizeSampleGrade(grade: SampleGrade): string[] {
  const lines: string[] = [];
  lines.push(
    `Density: ${grade.bucketLabel}` +
      (grade.arealDensityPerM2 != null
        ? ` · ≈ ${formatDensity(grade.arealDensityPerM2)} pts/m²`
        : ''),
  );
  if (grade.verticalSpanM > 0) {
    lines.push(`Vertical extent: ${grade.verticalSpanM.toFixed(1)} m`);
  }
  if (grade.occupancyRatio != null) {
    const pct = Math.round(grade.occupancyRatio * 100);
    const note =
      grade.occupancyRatio >= 0.85
        ? 'fills its footprint evenly'
        : grade.occupancyRatio >= 0.5
          ? 'partly hollow / irregular footprint'
          : 'sparse or hollow footprint — bbox overstates coverage';
    lines.push(`Coverage of bounding box: ${pct}% (${note})`);
  }
  return lines;
}

/** Format an areal density with sensible precision for the range it lands in. */
function formatDensity(d: number): string {
  if (d >= 100) return d.toFixed(0);
  if (d >= 10) return d.toFixed(1);
  return d.toFixed(2);
}
