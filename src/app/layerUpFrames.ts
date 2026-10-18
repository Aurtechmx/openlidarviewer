/**
 * layerUpFrames.ts — a loaded layer's up frame, resolved from that layer.
 *
 * The rule lives in `geo/frame/layerUpFrame.ts`; this module feeds it the facts
 * the running app holds for one layer: its source format and its own resolved
 * CRS (the live one for the active scan, the layer's own resolution, a
 * remembered override included, for any other). Measurement owner frames,
 * navigation up, the measurement and map exports and the layer details all
 * read a layer's axis here, so they cannot disagree with each other or with
 * the terrain gather and the converter, which apply the same rule.
 */

import type { PointCloud } from '../model/PointCloud';
import type { CrsService } from '../geo/CrsService';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { datasetIdentity } from '../geo/CrsService';
import type { SpatialContext } from '../geo/SpatialContext';
import { resolveLayerUpFrame, spatialUpAxisOf, upFrameRefusal, upVectorOf, type LayerCrs, type LayerUpFrame } from '../geo/frame/layerUpFrame';
import type { MeasureUnitFrame } from '../render/measure/types';
import type { SpatialUpAxis } from '../geo/SpatialContext';

/** The CRS reads a layer's frame needs. `current` is optional for narrow test seams. */
export type LayerFrameCrs = Pick<CrsService, 'context' | 'resolveFor'> & Partial<Pick<CrsService, 'current'>>;

/** The CRS facts of the active scan's live context, when no resolved CRS object is at hand. */
function contextCrs(ctx: SpatialContext): LayerCrs {
  return { kind: ctx.kind, name: ctx.crsName, ...(ctx.epsg != null ? { epsg: ctx.epsg } : {}) } as LayerCrs;
}

/** A layer's own resolved CRS: the live one when it is the active scan. */
export function layerCrsOf(crs: LayerFrameCrs, cloud: PointCloud, active: boolean): LayerCrs | null {
  if (active) return crs.current ? crs.current() : contextCrs(crs.context());
  return crs.resolveFor({ name: cloud.name, detected: cloud.metadata?.crs ?? undefined, source: 'las-vlr', identity: datasetIdentity(cloud) }) as ResolvedCrs;
}

/** The up frame of one loaded layer. */
export function layerUpFrameOf(crs: LayerFrameCrs, cloud: PointCloud, active: boolean): LayerUpFrame {
  return resolveLayerUpFrame({ format: cloud.sourceFormat, crs: layerCrsOf(crs, cloud, active) });
}

/** The up fields of a measurement unit frame for a layer's resolved frame. */
export function measureUpFieldsOf(frame: LayerUpFrame): Pick<MeasureUnitFrame, 'up' | 'upBasis' | 'upRefusal'> {
  const refusal = upFrameRefusal(frame);
  return { up: upVectorOf(frame), upBasis: frame.basis, ...(refusal ? { upRefusal: refusal } : {}) };
}

/** The slice of the running app the active scan's axis is read from. */
export interface ActiveLayerAxisSource {
  readonly activeCloud: () => PointCloud | null | undefined;
  /** A streaming (COPC/EPT) scan is open: LAS-derived, Z-up by specification. */
  readonly streaming: () => boolean;
  readonly crs: LayerFrameCrs;
}

/**
 * The active scan's up axis for lon/lat placement, footprints and the cursor
 * readout: the resolved axis where a specification, a CRS or a reading settled
 * it, else `'unknown'` (see `spatialUpAxisOf`).
 */
export function activeSpatialUpAxis(src: ActiveLayerAxisSource): SpatialUpAxis {
  const c = src.activeCloud();
  if (c) return spatialUpAxisOf(layerUpFrameOf(src.crs, c, true));
  return src.streaming() ? 'z' : 'unknown';
}

/**
 * A layer's up vector for navigation, by viewer id; null when the id is not an
 * open layer (the caller keeps the format rule). An unresolved frame navigates
 * by the axis it is drawn with.
 */
export function layerUpVectorResolver(
  cloud: (viewerId: string) => PointCloud | undefined,
  activeId: () => string | null,
  crs: LayerFrameCrs,
): (viewerId: string) => [number, number, number] | null {
  return (id) => {
    const c = cloud(id);
    return c ? upVectorOf(layerUpFrameOf(crs, c, id === activeId())) : null;
  };
}

/**
 * Move the measurements whose layer has no resolved up axis out of a report's
 * printed set: the report converts every figure along one up, and these have
 * none. The withheld sentence gains the reason and the fix.
 */
export function withholdUnresolvedUp<M extends { readonly id: string }>(
  owned: { readonly own: M[]; readonly withheldCount: number; readonly withheld: string | null },
  upRefusalOf: (m: M) => string | null | undefined,
): { readonly own: M[]; readonly withheldCount: number; readonly withheld: string | null } {
  const refusals = owned.own.map((m) => upRefusalOf(m) ?? null);
  const n = refusals.filter((r) => r !== null).length;
  if (n === 0) return owned;
  const reason = refusals.find((r) => r !== null)!.replace(/^not available: no up axis; /, '');
  const sentence = `${n} ${n === 1 ? 'measurement was' : 'measurements were'} left out: ${n === 1 ? 'its layer has' : 'their layer has'} no resolved up axis. ${reason}`;
  return {
    own: owned.own.filter((_, i) => refusals[i] === null),
    withheldCount: owned.withheldCount + n,
    withheld: owned.withheld ? `${owned.withheld} ${sentence}` : sentence,
  };
}
