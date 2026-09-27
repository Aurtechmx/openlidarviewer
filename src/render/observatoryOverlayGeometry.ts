/**
 * observatoryOverlayGeometry.ts: pure texel buffers for the Observatory's
 * empty-space slice plane (OB-PR-02, `ObservatoryOverlay.ts`).
 *
 * The O11 benchmark (validation/protocols/observatory-o11-v1.md, record in
 * validation/performance/observatory-o11/) kept the slice plane over
 * instanced boxes, so the overlay is one horizontal plane through the field
 * at one `iz` level, with one RGBA8 texel per voxel of that level.
 *
 * PRESENTATION, NOT SCIENCE: this only colours already-decided states. It
 * never decides a state, and it never changes a canonical byte (OB-INV-06).
 * Four things are drawn: `OBSERVED_EMPTY`, `SHADOWED`, `UNADDRESSED` and the
 * shadow frontier. Every other state is transparent, so an unaddressed or
 * not-read voxel is never shown as empty (OB-INV-01).
 */
import { OBSERVATION_STATE_GLYPH, OBSERVATION_STATE_LABEL, OBSERVATION_STATE_RGB } from '../observation/presentationLegend';
import type { ObservationState } from '../observation/types';

/** Largest slice edge in texels (the protocol's `MAX_SLICE_EDGE`). Wider fields are strided. */
export const MAX_SLICE_EDGE = 1024;

/** The states the slice shows, in legend order. */
export const SLICE_STATES: readonly ObservationState[] = ['OBSERVED_EMPTY', 'SHADOWED', 'UNADDRESSED'];

const SLICE_ALPHA = 200;
const FRONTIER_RGB: readonly [number, number, number] = [0.95, 0.3, 0.75];
export const FRONTIER_GLYPH = '◆';
const FRONTIER_ALPHA = 235;

export interface SliceGrid { readonly nx: number; readonly ny: number; readonly nz: number }

/** Texel stride so neither slice edge exceeds {@link MAX_SLICE_EDGE}. 1 for every field that fits. */
export function sliceStride(grid: SliceGrid): number {
  return Math.max(1, Math.ceil(Math.max(grid.nx, grid.ny) / MAX_SLICE_EDGE));
}

/** Texture size for `grid` after the stride. */
export function sliceSize(grid: SliceGrid): { readonly width: number; readonly height: number; readonly stride: number } {
  const stride = sliceStride(grid);
  return { width: Math.ceil(grid.nx / stride), height: Math.ceil(grid.ny / stride), stride };
}

/**
 * RGBA8 texels for level `iz`, row-major with x fastest, one per (strided)
 * voxel. Frontier voxels take the frontier colour over their state colour.
 * Keys are `ledger.ts#packVoxelKey`'s `ix + nx * (iy + ny * iz)`.
 */
export function buildSliceTexels(
  stateOf: (key: number) => ObservationState | undefined,
  frontier: ReadonlySet<number>,
  grid: SliceGrid,
  iz: number,
  out?: Uint8Array,
): Uint8Array {
  const { width, height, stride } = sliceSize(grid);
  const texels = out && out.length === width * height * 4 ? out : new Uint8Array(width * height * 4);
  texels.fill(0);
  if (iz < 0 || iz >= grid.nz) return texels;
  for (let ty = 0; ty < height; ty++) {
    const iy = ty * stride;
    for (let tx = 0; tx < width; tx++) {
      const ix = tx * stride;
      const key = ix + grid.nx * (iy + grid.ny * iz);
      const w = (ty * width + tx) * 4;
      if (frontier.has(key)) {
        texels[w] = Math.round(FRONTIER_RGB[0] * 255);
        texels[w + 1] = Math.round(FRONTIER_RGB[1] * 255);
        texels[w + 2] = Math.round(FRONTIER_RGB[2] * 255);
        texels[w + 3] = FRONTIER_ALPHA;
        continue;
      }
      const state = stateOf(key);
      if (!state || !SLICE_STATES.includes(state)) continue;
      const rgb = OBSERVATION_STATE_RGB[state];
      texels[w] = Math.round(rgb[0] * 255);
      texels[w + 1] = Math.round(rgb[1] * 255);
      texels[w + 2] = Math.round(rgb[2] * 255);
      texels[w + 3] = SLICE_ALPHA;
    }
  }
  return texels;
}

/** The level with the most `SHADOWED` voxels, lowest level on a tie; 0 when none. The slice opens there. */
export function defaultSliceLevel(shadowedKeys: Iterable<number>, grid: SliceGrid): number {
  const perLevel = new Array<number>(grid.nz).fill(0);
  const plane = grid.nx * grid.ny;
  for (const key of shadowedKeys) perLevel[Math.floor(key / plane)]!++;
  let best = 0;
  for (let iz = 1; iz < grid.nz; iz++) if (perLevel[iz]! > perLevel[best]!) best = iz;
  return best;
}

/** The slice legend, glyph and word per shown state (OB-PR-04: colour is never the only carrier). */
export function sliceLegendText(): string {
  const states = SLICE_STATES.map((s) => `${OBSERVATION_STATE_GLYPH[s]} ${OBSERVATION_STATE_LABEL[s]}`);
  return [...states, `${FRONTIER_GLYPH} Frontier`].join(', ');
}
