/**
 * profileSheetExtras.ts: what a Light or Dark profile sheet draws beyond the
 * sampled ground line: the corridor's returns, the plan strip and the index
 * contour crossings.
 *
 * Every figure is put in the frame of the profile's own samples. The samples
 * the panel holds were converted from the measurement's raw series by
 * `scaleProfileSamples`: distance times the horizontal factor, height plus
 * the elevation datum times the vertical factor. The returns and contour
 * heights are read in the raw frame, so the same conversion is read off one
 * raw and converted sample pair and applied to them. Nothing is assumed about
 * a datum the samples do not already show.
 *
 * The plan strip is drawn only from a fresh terrain analysis of the scan the
 * profile was measured on; otherwise it is left out and the sheet says so.
 */
import type { Viewer } from '../render/Viewer';
import type { ProfileChartSample } from '../render/measure/types';
import type { MeasurementSummary } from '../render/measure/MeasureController';
import type { ProfileSheetExtras, ProfileSheetReturns } from '../render/measure/profileSheetStyled';
import type { AnalyseContoursResult } from '../terrain/contour/analyseContours';
import { annotationToMapXY } from '../render/measure/annotationMapProjection';

/** Most returns put on a sheet; a denser corridor is thinned evenly. */
export const MAX_SHEET_RETURNS = 400_000;

/** A fresh terrain analysis of one scan, and the up axis its grid is drawn in. */
export interface ProfileTerrainRef {
  readonly result: AnalyseContoursResult;
  readonly sceneUpAxis: 'z' | 'y' | null;
}

/** The raw-to-sheet conversion read off a sample pair: chainage × f, (height + datum) × vf. */
export interface SampleFrame {
  readonly f: number;
  readonly vf: number;
  readonly datum: number;
}

/**
 * The conversion from the raw series to the converted one, from the first
 * sample pair with a non-zero distance and finite heights. Null when no pair
 * shows it.
 */
export function sampleFrame(raw: readonly ProfileChartSample[], shown: readonly ProfileChartSample[], vf: number): SampleFrame | null {
  if (!(vf > 0)) return null;
  for (let i = 0; i < Math.min(raw.length, shown.length); i++) {
    const r = raw[i]!, s = shown[i]!;
    if (!(r.distance > 0) || !Number.isFinite(r.height) || !Number.isFinite(s.height)) continue;
    const f = s.distance / r.distance;
    if (!(f > 0) || !Number.isFinite(f)) continue;
    return { f, vf, datum: s.height / vf - r.height };
  }
  return null;
}

/**
 * True when the returns' median distance from the ground line, at their own
 * chainages, is within the section's relief or 25 m, whichever is larger. A
 * return set read in another height frame sits off the line by a datum
 * (hundreds of metres for a recentred scan), far outside that.
 */
export function returnsAgree(chainageM: ArrayLike<number>, heightM: ArrayLike<number>, line: readonly ProfileChartSample[]): boolean {
  const pts = line.filter((p) => Number.isFinite(p.height));
  if (pts.length < 2) return false;
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p.height < lo) lo = p.height; if (p.height > hi) hi = p.height; }
  const res: number[] = [];
  const step = Math.max(1, Math.floor(chainageM.length / 2000));
  for (let i = 0; i < chainageM.length; i += step) {
    const c = chainageM[i]!;
    let j = 1;
    while (j < pts.length && pts[j]!.distance < c) j++;
    if (j >= pts.length) continue;
    const a = pts[j - 1]!, b = pts[j]!;
    if (c < a.distance) continue;
    const g = b.distance > a.distance ? a.height + ((c - a.distance) / (b.distance - a.distance)) * (b.height - a.height) : a.height;
    res.push(Math.abs(heightM[i]! - g));
  }
  if (res.length === 0) return false;
  res.sort((x, y) => x - y);
  return res[Math.floor(res.length / 2)]! <= Math.max(25, hi - lo);
}

/** Yield to the browser between chunks of a corridor walk. */
const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The extras for the profile `id`, or null when nothing beyond the ground line can be drawn. */
export async function profileSheetExtras(
  viewer: Viewer,
  id: string,
  summary: MeasurementSummary,
  /**
   * The fresh analysis of the scan with this stable layer id, or null when
   * there is none. A null id is a profile with no owner, which a scene of one
   * scan leaves unowned: the host answers for that one scan only.
   */
  terrainFor: (stableLayerId: string | null) => ProfileTerrainRef | null,
): Promise<ProfileSheetExtras | null> {
  const m = viewer.measure.getMeasurements().find((x) => x.id === id);
  if (!m || m.kind !== 'profile' || !m.profileChart || !summary.profileChart || m.points.length < 2) return null;
  const unit = viewer.measure.unitFrameOf(m);
  const frame = sampleFrame(m.profileChart, summary.profileChart, unit.verticalUnitToMetres ?? unit.unitToMetres);
  if (!frame) return null;

  // The corridor's returns, walked in chunks so a dense corridor does not hold the page.
  let returns: ProfileSheetReturns | null = null;
  const half = summary.profileCorridorWidthM != null ? summary.profileCorridorWidthM / frame.f : null;
  // Cut along the profile's own up axis, as its samples were, not the active layer's.
  const walk = viewer.profileSeam.sectionChunks({ a: m.points[0]!, b: m.points[1]!, corridorWidth: half, up: unit.up ?? null });
  let step = walk.next();
  while (!step.done) {
    await nextTick();
    step = walk.next();
  }
  const section = step.value;
  if (section && section.points.count > 0) {
    const pts = section.points;
    const stride = Math.max(1, Math.ceil(pts.count / MAX_SHEET_RETURNS));
    const n = Math.ceil(pts.count / stride);
    const chainageM = new Float32Array(n), heightM = new Float64Array(n);
    const cls = pts.classification;
    const ground = cls ? new Uint8Array(n) : null;
    for (let j = 0, i = 0; i < pts.count; i += stride, j++) {
      chainageM[j] = pts.chainage[i]! * frame.f;
      heightM[j] = (pts.height[i]! + frame.datum) * frame.vf;
      if (ground && cls) ground[j] = cls[i] === 2 ? 1 : 0;
    }
    // The returns sit on and above the ground line they were sampled into. If
    // they do not, the two were read in different frames: leave them off
    // rather than draw them in the wrong place.
    if (returnsAgree(chainageM, heightM, summary.profileChart)) returns = { count: n, chainageM, heightM, ground };
  }

  // The plan strip and the index crossings, from a fresh analysis of this scan.
  const ownScan = m.owner?.layerId ?? null;
  const terrain = terrainFor(ownScan);
  if (!terrain) return { returns, plan: null, indexLevels: null };
  const t = terrain.result;
  const up = terrain.sceneUpAxis ?? 'z';
  const xyz = (p: readonly [number, number, number]) => ({ x: p[0], y: p[1], z: p[2] });
  const a = annotationToMapXY(xyz(m.points[0]!), up), b = annotationToMapXY(xyz(m.points[1]!), up);
  const indexLevels = [...new Set(t.model.features.filter((f) => f.isIndex).map((f) => f.value))]
    .map((v) => (v + frame.datum) * frame.vf);
  return {
    returns,
    plan: {
      relief: { cols: t.dtm.cols, rows: t.dtm.rows, cellSize: t.dtm.cellSizeM, originX: t.dtm.originH1, originY: t.dtm.originH2, z: t.dtm.z, coverage: t.dtm.coverage },
      a: [a.x, a.y], b: [b.x, b.y], unitToMetres: frame.f, contours: t.model,
    },
    indexLevels,
  };
}
