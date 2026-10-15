/**
 * measureLayerUnits.ts
 *
 * The unit frame each measurement is read out in. Render space keeps every
 * layer's source units, so a measurement taken on a US-survey-foot scan holds
 * feet and one taken on a metre scan holds metres. Its lengths, areas, volumes,
 * grade and frame refusals must use the factors of the layer it was taken on,
 * never those of whichever scan is active.
 *
 * The active scan's frame comes from the live spatial context; any other open
 * layer is resolved from its own CRS (a remembered override included), as the
 * per-scan export frame does. A layer id that no open layer carries, or that
 * more than one carries, has no frame: its work reads as unverified.
 *
 * The frame also carries the layer's own up axis (Z for a survey format, Y for
 * a mesh format), so a height reads along the axis its layer was captured in,
 * not along whichever up the active scan gave the scene.
 */

import type { PointCloud } from '../model/PointCloud';
import type { CrsService } from '../geo/CrsService';
import type { MeasureController } from '../render/measure/MeasureController';
import { UNRESOLVED_UNIT_FRAME, sameUnitFrame, type MeasureUnitFrame } from '../render/measure/types';
import { measureUnitFrameOf, scanContextOf } from './measurementExportFrame';
import { upOfFormat } from '../io/sniffFormat';

/** The slice of the app a layer's unit frame is resolved from. */
export interface LayerUnitSource {
  /** Viewer id of the active scan, or null. */
  readonly activeId: () => string | null;
  /** Viewer ids of the open static layers. */
  readonly clouds: () => readonly string[];
  readonly cloud: (viewerId: string) => PointCloud | undefined;
  readonly stableIdFor: (viewerId: string) => string | null;
  readonly crs: Pick<CrsService, 'context' | 'resolveFor'>;
}

/** The binding the CRS subscription drives. */
export interface MeasureUnitFrames {
  /** The active scan's CRS changed (or the active scan did): re-feed the controller. */
  onCrsChange(): void;
}

/**
 * Feed the controller the active scan's frame and a resolver for every other
 * layer. Frames are memoised per layer until the set of open layers, the active
 * scan or a CRS changes; the controller reads them on every overlay frame.
 */
export function bindMeasureUnitFrames(measure: MeasureController, src: LayerUnitSource): MeasureUnitFrames {
  const memo = new Map<string, MeasureUnitFrame>();
  let memoKey = '';
  const resolve = (layerId: string): MeasureUnitFrame | null => {
    const ids = src.clouds();
    // A streamed scan with no static layer open: its own work records no
    // layer, and the live frame is the only one there is.
    if (ids.length === 0) return null;
    // Layer ids are bound after a load resolves, so the binding is part of the key.
    const key = `${src.activeId() ?? ''}|${ids.map((id) => `${id}=${src.stableIdFor(id) ?? ''}`).join(',')}`;
    if (key !== memoKey) {
      memo.clear();
      memoKey = key;
    }
    const hit = memo.get(layerId);
    if (hit) return hit;
    const matches = ids.filter((id) => src.stableIdFor(id) === layerId);
    let out: MeasureUnitFrame = UNRESOLVED_UNIT_FRAME;
    if (matches.length === 1) {
      const id = matches[0]!;
      const c = src.cloud(id);
      if (id === src.activeId()) out = { ...measureUnitFrameOf(src.crs.context()), ...(c ? { up: upOfFormat(c.sourceFormat) } : {}) };
      else if (c) out = { ...measureUnitFrameOf(scanContextOf(src.crs, c)), up: upOfFormat(c.sourceFormat) };
    }
    memo.set(layerId, out);
    return out;
  };
  measure.setUnitResolver(resolve);
  return {
    onCrsChange() {
      memo.clear();
      const f = measureUnitFrameOf(src.crs.context());
      measure.setUnitToMetres(f.unitToMetres);
      measure.setVerticalUnitToMetres(f.verticalUnitToMetres ?? 1);
      measure.setVerticalUnitKnown(f.verticalUnitKnown);
      measure.setCrsKnown(f.crsKnown);
      measure.setGeographicCrs(f.geographic, f.verticalRefused);
      measure.setProjectedCrs(f.projected);
      // Owned work re-reads its layer's frame (a late resolve or an override
      // on another layer); the setters above only re-emit when a value moved.
      measure.refreshUnitFrames();
    },
  };
}

/**
 * The one unit frame a chain total may be computed in, or the refusal: values
 * taken on scans with different units have no common factor to sum under.
 */
export function chainUnitFrame(frames: readonly MeasureUnitFrame[]): { frame: MeasureUnitFrame } | { refusal: string } {
  const first = frames[0];
  if (!first) return { frame: UNRESOLVED_UNIT_FRAME };
  const up = (f: MeasureUnitFrame): string => (f.up ? f.up.join(',') : 'scene');
  if (frames.some((f) => f.upConflict === true || up(f) !== up(first))) return { refusal: 'not combined: the selected measurements sit on layers with different up axes' };
  if (frames.every((f) => sameUnitFrame(f, first))) return { frame: first };
  return { refusal: 'not combined: the selected measurements were taken on scans with different units' };
}
