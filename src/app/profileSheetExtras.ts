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
 * The returns are the recorded sources' own: the profile keeps which scans it
 * was sampled from, and a scan shown since adds nothing. When a recorded scan
 * cannot be read, the returns are left out and the sheet says why.
 *
 * The plan strip and the contour crossings are drawn only from a fresh terrain
 * analysis of the scan the profile was picked on; otherwise they are left out
 * and the sheet says so.
 */
import type { Viewer } from '../render/Viewer';
import type { ProfileChartSample } from '../render/measure/types';
import type { MeasurementSummary } from '../render/measure/MeasureController';
import { quantileSorted } from '../terrain/quantile';
import { NON_GROUND_CLASSES } from '../terrain/ground/classificationFilter';
import type { ProfileSheetExtras, ProfileSheetReturns, ProfileStationSample } from '../render/measure/profileSheetStyled';
import type { ProfileSectionResult } from '../render/measure/profileSectionSeam';
import { STREAMING_SOURCE_ID } from '../render/measure/profileSectionSeam';
import type { ProfileProvenance } from '../render/measure/profileProvenance';
import type { ContourFeatureModel } from '../terrain/contour/contourFeatureModel';
import { ownerIdsOf, type OwnedItem } from './measurementOwnership';
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

/** Why a profile's returns are left off the sheet. */
export const RETURNS_NOT_READ = 'not drawn: a scan this profile was sampled from is hidden or closed';
export const RETURNS_UNRECORDED = 'not drawn: the profile does not record which of the open scans it was sampled from';
export const RETURNS_OFF_LINE = 'not drawn: the returns read now do not lie along the sampled line';

/**
 * The section slots holding returns of the scans the profile was sampled from,
 * or why they cannot be told. A source is matched by its stable id. An id no
 * open scan has comes from a session of one scan reopened later, or from a
 * record that named its source by file name: the file name then counts when it
 * was the only source, one open scan carries it, and the profile names no scan
 * that is not open. A stream recorded as "streaming" counts only for work that
 * names no scan. With no record at all, the one open scan is the source.
 */
export function recordedSlots(
  m: OwnedItem,
  provenance: ProfileProvenance | undefined,
  section: Pick<ProfileSectionResult, 'sources' | 'streamingSourceId'>,
  open: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): { readonly slots: ReadonlySet<number> } | { readonly note: string } {
  const statics = section.sources.filter((s) => s.kind === 'static');
  const residents = section.sources.filter((s) => s.kind === 'resident');
  if (!provenance) {
    return open.length + (residents.length > 0 ? 1 : 0) <= 1 ? { slots: new Set(section.sources.map((s) => s.slot)) } : { note: RETURNS_UNRECORDED };
  }
  const slots = new Set<number>();
  const used = provenance.sources.filter((s) => s.contributed);
  const namesOpen = ownerIdsOf(m).every((id) => open.some((l) => l.id === id));
  for (const src of used) {
    if (src.streaming) {
      const same = src.layerId === section.streamingSourceId || (src.layerId === STREAMING_SOURCE_ID && ownerIdsOf(m).length === 0);
      if (!same || residents.length === 0) return { note: RETURNS_NOT_READ };
      for (const r of residents) slots.add(r.slot);
      continue;
    }
    let hits = statics.filter((s) => s.id === src.layerId);
    const known = open.some((l) => l.id === src.layerId);
    if (hits.length === 0 && !known && used.length === 1 && namesOpen && open.filter((l) => l.name === src.displayName).length === 1) {
      hits = statics.filter((s) => (s.name ?? s.id) === src.displayName);
    }
    if (hits.length === 0) return { note: RETURNS_NOT_READ };
    if (hits.length > 1) return { note: RETURNS_UNRECORDED };
    slots.add(hits[0]!.slot);
  }
  return { slots };
}

/**
 * Where the line from `a` to `b` meets an index contour, in the contours' own
 * frame: the distance along the line and the contour's value. A contour at the
 * line's height somewhere else on the scan is not a crossing.
 */
export function contourCrossings(
  a: readonly [number, number],
  b: readonly [number, number],
  features: ContourFeatureModel['features'],
): Array<{ along: number; value: number }> {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return [];
  const ux = dx / len, uy = dy / len;
  const out: Array<{ along: number; value: number }> = [];
  for (const f of features) {
    const c = f.coordinates;
    if (!f.isIndex || c.length < 2) continue;
    const n = c.length;
    const ring = f.closed && (c[0]![0] !== c[n - 1]![0] || c[0]![1] !== c[n - 1]![1]);
    for (let i = 1; i < n + (ring ? 1 : 0); i++) {
      const p = c[i - 1]!, q = c[i % n]!;
      // Along the line, and to its left.
      const pu = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy, pv = (p[1] - a[1]) * ux - (p[0] - a[0]) * uy;
      const qu = (q[0] - a[0]) * ux + (q[1] - a[1]) * uy, qv = (q[1] - a[1]) * ux - (q[0] - a[0]) * uy;
      // A segment lying along the line has no one crossing point.
      if (pv === qv || (pv > 0 && qv > 0) || (pv < 0 && qv < 0)) continue;
      const along = pu + (pv / (pv - qv)) * (qu - pu);
      if (along < 0 || along > len) continue;
      // A shared vertex on the line is met by both of its segments.
      if (!out.some((o) => o.value === f.value && Math.abs(o.along - along) <= len * 1e-9)) out.push({ along, value: f.value });
    }
  }
  return out.sort((x, y) => x.along - y.along);
}

/** Most heights kept for the one-station drawing. */
const MAX_STATION_HEIGHTS = 1500;
/** The one-station drawing is made only when its percentile gives the sampled height to this, in raw units. */
const STATION_MATCH = 0.005;

/**
 * The accepted returns of the station at `index`, and the height they give, in
 * the raw frame; null unless that height is the one the profile recorded. The
 * section keeps every class, so the sampler's class rule is applied again, and
 * only a station whose own percentile comes back is worth showing.
 */
export function stationReturns(
  raw: readonly ProfileChartSample[],
  index: number,
  percentile: number,
  pts: { readonly count: number; readonly chainage: ArrayLike<number>; readonly height: ArrayLike<number>; readonly classification?: ArrayLike<number> | null },
  accept: (i: number) => boolean,
): { heights: Float64Array; kept: number } | null {
  const at = raw[index], next = raw[index + 1] ?? raw[index - 1];
  if (!at || !next || !Number.isFinite(at.height)) return null;
  const step = Math.abs(next.distance - at.distance);
  if (!(step > 0)) return null;
  const drop = new Set<number>(NON_GROUND_CLASSES);
  const hs: number[] = [];
  for (let i = 0; i < pts.count; i++) {
    if (!accept(i) || (pts.classification && drop.has(pts.classification[i]!))) continue;
    // The sampler's own binning: the nearest station.
    if (Math.round(pts.chainage[i]! / step) === index) hs.push(pts.height[i]!);
  }
  if (hs.length < 8 || (at.count != null && at.count !== hs.length)) return null;
  const heights = Float64Array.from(hs).sort();
  const kept = quantileSorted(heights, percentile / 100);
  return Math.abs(kept - at.height) <= STATION_MATCH ? { heights, kept } : null;
}

/** The lowest station clear of the ends, with its returns, converted to the sheet's frame. */
function lowestStation(
  raw: readonly ProfileChartSample[],
  percentile: number | null,
  pts: Parameters<typeof stationReturns>[3],
  accept: (i: number) => boolean,
  frame: SampleFrame,
): ProfileStationSample | null {
  if (percentile == null) return null;
  let low = -1;
  for (let i = 1; i < raw.length - 1; i++) {
    if (Number.isFinite(raw[i]!.height) && (low < 0 || raw[i]!.height < raw[low]!.height)) low = i;
  }
  if (low < 0) return null;
  const got = stationReturns(raw, low, percentile, pts, accept);
  if (!got) return null;
  const up = (h: number): number => (h + frame.datum) * frame.vf;
  const stride = Math.max(1, Math.ceil(got.heights.length / MAX_STATION_HEIGHTS));
  return {
    chainageM: raw[low]!.distance * frame.f, keptM: up(got.kept), percentile, accepted: got.heights.length,
    heightsM: Float64Array.from(got.heights.filter((_, i) => i % stride === 0), up),
  };
}

/** Yield to the browser between chunks of a corridor walk. */
const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The extras for the profile `id`, or null when nothing beyond the ground line can be drawn. */
export async function profileSheetExtras(
  viewer: Viewer,
  id: string,
  summary: MeasurementSummary,
  /**
   * The fresh analysis of the one scan the profile was picked on, or null when
   * there is none or the profile belongs to no one scan.
   */
  terrainFor: (m: OwnedItem) => ProfileTerrainRef | null,
): Promise<ProfileSheetExtras | null> {
  const m = viewer.measure.getMeasurements().find((x) => x.id === id);
  if (!m || m.kind !== 'profile' || !m.profileChart || !summary.profileChart || m.points.length < 2) return null;
  const unit = viewer.measure.unitFrameOf(m);
  const frame = sampleFrame(m.profileChart, summary.profileChart, unit.verticalUnitToMetres ?? unit.unitToMetres);
  if (!frame) return null;

  // The corridor's returns, walked in chunks so a dense corridor does not hold the page.
  let returns: ProfileSheetReturns | null = null;
  let returnsNote: string | null = null;
  let station: ProfileStationSample | null = null;
  const half = summary.profileCorridorWidthM != null ? summary.profileCorridorWidthM / frame.f : null;
  // Cut along the profile's own up axis, as its samples were, not the active layer's.
  // Independent, so this read and the workbench's section never cancel each other.
  const walk = viewer.profileSeam.sectionChunks({ a: m.points[0]!, b: m.points[1]!, corridorWidth: half, up: unit.up ?? null, independent: true });
  let step = walk.next();
  while (!step.done) {
    await nextTick();
    step = walk.next();
  }
  const section = step.value;
  if (section) {
    const pts = section.points;
    const open = viewer.clouds().map((c) => {
      const cloud = viewer.getCloud(c);
      return { id: viewer.layerSourceId?.(cloud) ?? cloud?.name ?? '', name: cloud?.name ?? '' };
    });
    const own = recordedSlots(m, m.profileProvenance, section, open);
    if ('note' in own) returnsNote = own.note;
    else {
      let total = 0;
      for (let i = 0; i < pts.count; i++) if (own.slots.has(pts.sourceSlot[i]!)) total++;
      const stride = Math.max(1, Math.ceil(total / MAX_SHEET_RETURNS));
      const n = Math.ceil(total / stride);
      const chainageM = new Float32Array(n), heightM = new Float64Array(n);
      const cls = pts.classification;
      const ground = cls ? new Uint8Array(n) : null;
      for (let i = 0, k = 0, j = 0; i < pts.count; i++) {
        if (!own.slots.has(pts.sourceSlot[i]!) || k++ % stride !== 0) continue;
        chainageM[j] = pts.chainage[i]! * frame.f;
        heightM[j] = (pts.height[i]! + frame.datum) * frame.vf;
        if (ground && cls) ground[j] = cls[i] === 2 ? 1 : 0;
        j++;
      }
      // The returns sit on and above the ground line they were sampled into. If
      // they do not, the two were read in different frames: leave them off
      // rather than draw them in the wrong place.
      if (n > 0) {
        if (returnsAgree(chainageM, heightM, summary.profileChart)) {
          returns = { count: n, chainageM, heightM, ground };
          station = lowestStation(m.profileChart, m.profileGroundPercentile ?? null, pts, (i) => own.slots.has(pts.sourceSlot[i]!), frame);
        } else returnsNote = RETURNS_OFF_LINE;
      }
    }
  }

  // The plan strip and the index crossings, from a fresh analysis of this scan.
  const terrain = terrainFor(m);
  if (!terrain) return { returns, returnsNote, station, plan: null, indexCrossings: null };
  const t = terrain.result;
  const up = terrain.sceneUpAxis ?? 'z';
  const xyz = (p: readonly [number, number, number]) => ({ x: p[0], y: p[1], z: p[2] });
  const a = annotationToMapXY(xyz(m.points[0]!), up), b = annotationToMapXY(xyz(m.points[1]!), up);
  const indexCrossings = contourCrossings([a.x, a.y], [b.x, b.y], t.model.features)
    .map((c) => ({ chainage: c.along * frame.f, height: (c.value + frame.datum) * frame.vf }));
  return {
    returns,
    returnsNote,
    station,
    plan: {
      relief: { cols: t.dtm.cols, rows: t.dtm.rows, cellSize: t.dtm.cellSizeM, originX: t.dtm.originH1, originY: t.dtm.originH2, z: t.dtm.z, coverage: t.dtm.coverage },
      a: [a.x, a.y], b: [b.x, b.y], unitToMetres: frame.f, corridorM: summary.profileCorridorWidthM ?? null, contours: t.model,
    },
    indexCrossings,
  };
}
