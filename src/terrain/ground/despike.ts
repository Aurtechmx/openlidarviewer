/**
 * despike.ts
 *
 * Robust outlier rejection for a rasterised DTM surface. A single bad ground
 * return (a low point under a bridge, a multipath blunder, a misclassified
 * vegetation hit) lands one cell far from its neighbours and warps contours.
 * This flags such cells using a local median + MAD (median absolute deviation)
 * test — robust, so a real spike doesn't inflate the threshold that catches it.
 *
 * `findSpikes` only reports; `removeSpikes` returns arrays with the spikes
 * demoted to "no data" so the DTM builder re-fills them by interpolation. Both
 * are pure and deterministic.
 *
 * `z` arrives in NATIVE source vertical units; `minDeviationM` is metres. The
 * caller must pass `verticalUnitToMetres` for anything but metric data, or the
 * absolute floor silently means source units.
 */

export interface DespikeParams {
  /** Neighbourhood radius (cells) for the local median. Default 1 (3×3). */
  readonly radius?: number;
  /** A cell is a spike when |z − median| > threshold × (1.4826·MAD). Default 5. */
  readonly madThreshold?: number;
  /** Absolute floor (metres): deviations below this are never spikes. Default 0.05. */
  readonly minDeviationM?: number;
  /** Minimum measured neighbours required to judge a cell. Default 4. */
  readonly minNeighbours?: number;
  /**
   * Metres per source vertical unit (~0.3048 for feet). Default 1.
   *
   * `minDeviationM` is a METRES constant while `z` is in native source units,
   * so the deviation must be converted before the two are compared. Without it
   * the 0.3 m blunder floor acted as 0.3 ft = 9.1 cm on foot data — 3.28x too
   * aggressive — and real sub-30 cm features were deleted and re-interpolated,
   * with the removal count reaching provenance. The MAD term needs no
   * conversion of its own (it is a ratio of like units) but is scaled here too
   * so the whole comparison happens in one unit.
   */
  readonly verticalUnitToMetres?: number;
}

const MAD_TO_SIGMA = 1.4826;

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  return n % 2 ? sorted[(n - 1) >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Flag spike cells. Returns a Uint8Array (1 = spike) parallel to `z`; only
 * cells with `hadData[i] === 1` can be flagged.
 */
export function findSpikes(
  z: Float32Array | ReadonlyArray<number>,
  hadData: Uint8Array | ReadonlyArray<number>,
  cols: number,
  rows: number,
  params: DespikeParams = {},
): Uint8Array {
  const n = cols * rows;
  const out = new Uint8Array(n);
  const radius = Math.max(1, Math.floor(params.radius ?? 1));
  const madThreshold = params.madThreshold ?? 5;
  const minDev = Math.max(0, params.minDeviationM ?? 0.05);
  const minNeighbours = Math.max(1, params.minNeighbours ?? 4);
  // Scale the deviation and the MAD sigma into metres so `minDeviationM` means
  // metres on every source. A non-finite/non-positive factor is no factor (1),
  // never a silent 0 that would flag every cell.
  const vUnit =
    Number.isFinite(params.verticalUnitToMetres) && (params.verticalUnitToMetres as number) > 0
      ? (params.verticalUnitToMetres as number)
      : 1;

  const neigh: number[] = [];
  const dev: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (hadData[i] !== 1) continue;
      neigh.length = 0;
      for (let dr = -radius; dr <= radius; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -radius; dc <= radius; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (j === i || hadData[j] !== 1) continue;
          neigh.push(z[j] as number);
        }
      }
      if (neigh.length < minNeighbours) continue;
      neigh.sort((a, b) => a - b);
      const med = median(neigh);
      dev.length = 0;
      for (const v of neigh) dev.push(Math.abs(v - med));
      dev.sort((a, b) => a - b);
      const sigma = MAD_TO_SIGMA * median(dev) * vUnit;
      const d = Math.abs((z[i] as number) - med) * vUnit;
      const threshold = Math.max(madThreshold * sigma, minDev);
      if (d > threshold && d > minDev) out[i] = 1;
    }
  }
  return out;
}

/**
 * Return copies of `z` / `hadData` with flagged spikes demoted to no-data
 * (the DTM builder will re-interpolate them). The spike count is returned for
 * the honesty log.
 */
export function removeSpikes(
  z: Float32Array,
  hadData: Uint8Array,
  cols: number,
  rows: number,
  params: DespikeParams = {},
): { z: Float32Array; hadData: Uint8Array; removed: number } {
  const spikes = findSpikes(z, hadData, cols, rows, params);
  const outZ = z.slice();
  const outHad = hadData.slice();
  let removed = 0;
  for (let i = 0; i < spikes.length; i++) {
    if (spikes[i]) {
      outHad[i] = 0;
      outZ[i] = Number.NaN;
      removed++;
    }
  }
  return { z: outZ, hadData: outHad, removed };
}
