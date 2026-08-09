/**
 * compareLoadedLayers.ts — the two-epoch change-detection flow, lifted out of
 * the composition root.
 *
 * When exactly two clouds are loaded, coarse-register the second onto the first
 * (yaw + x/y only — vertical change is the signal), build a shared DTM pair,
 * difference them, and report alignment + cut/fill, plus a downloadable signed-
 * difference .asc. Every frame decision (metre scale, declared frame, vertical
 * unit) comes from ONE {@link SpatialContext} per epoch so alignment, difference
 * and the exported raster can never disagree.
 *
 * The heavy change-detection code is loaded on demand. The shell injects its
 * five seams ({@link CompareLayersDeps}) so this stays free of the viewer / GPU
 * and is unit-testable with fakes.
 */

import type { PointCloud } from '../model/PointCloud';
import { spatialContextFrom } from '../geo/SpatialContext';
import { epochFrameFacts, epochFrameOptions } from '../geo/frameCompatibility';
import { horizontalSpanXY } from '../render/measure/measureDerivations';
import {
  loadCompareEpochs,
  loadAlignEpochs,
  loadCompareDtms,
  loadChangeRaster,
} from '../lazyChunks';

/** A downloadable signed-difference raster: a stem name and a lazy ESRI-ASCII builder. */
export interface LayerDifference {
  readonly stem: string;
  readonly asc: () => string;
}

/** The shell seams the compare flow needs — no viewer / GPU objects. */
export interface CompareLayersDeps {
  /** Ids of the currently loaded clouds; the flow runs only when there are two. */
  cloudIds(): readonly string[];
  /** Resolve a cloud by id, or null when absent. */
  getCloud(id: string): PointCloud | null;
  /** Write the alignment + change summary lines into the Inspector. */
  setCompareResult(lines: string[]): void;
  /** Toggle whether a difference raster is offered for download. */
  setDifferenceAvailable(available: boolean): void;
  /** Store (or clear) the last computed difference raster. */
  setLastDifference(diff: LayerDifference | null): void;
}

/** Strip a file extension for a display / export stem. */
function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Compare the two loaded clouds as before/after epochs. No-op unless exactly two are loaded. */
export function compareLoadedLayers(deps: CompareLayersDeps): void {
  const ids = deps.cloudIds();
  if (ids.length !== 2) return;
  const a = deps.getCloud(ids[0]);
  const b = deps.getCloud(ids[1]);
  if (!a || !b) return;
  deps.setCompareResult(['Comparing elevations… running ground filters, one moment.']);
  deps.setDifferenceAvailable(false);
  deps.setLastDifference(null);
  void (async () => {
    // Load the change-detection code on demand, then yield a frame so the
    // "working" line paints before the synchronous ground-filter compute.
    const [{ buildSharedEpochDtms }, { alignEpochClouds, summarizeAlignment }, { compareDtms, summarizeChange }, { changeToEsriAscii }] =
      await Promise.all([
        loadCompareEpochs(),
        loadAlignEpochs(),
        loadCompareDtms(),
        loadChangeRaster(),
      ]);
    await new Promise((resolve) => setTimeout(resolve, 16));
    try {
      // Pass each cloud's origin: the two are recentred by their own origins, so
      // the comparison must align them in a common world frame, not raw local.
      // Unit info rides along so the shared grid's ~0.25 m cell floor is
      // expressed in SOURCE units (degrees/feet), not raw source-unit 0.25 —
      // and it now comes from ONE context per epoch, built at this boundary, so
      // alignment, difference and exported raster cannot disagree about the
      // metre scale (`epochFrameOptions`) or the declared frame
      // (`declaredFrameLabel` keeps two UNDECLARED scans off the "same frame"
      // branch instead of matching them on the display placeholder).
      const ctxA = spatialContextFrom(a.metadata?.crs);
      const ctxB = spatialContextFrom(b.metadata?.crs);
      const frames = epochFrameOptions(ctxA, ctxB);
      // `sourceOrigin`, not the live project origin: this is the epoch world
      // comparison. The frame facts come from each epoch's context.
      const beforeCloud = { positions: a.positions, origin: a.sourceOrigin, ...epochFrameFacts(ctxA) };
      const afterCloud = { positions: b.positions, origin: b.sourceOrigin, ...epochFrameFacts(ctxB) };
      // Coarse-register the after cloud onto the before cloud first (yaw + x/y
      // only — a real vertical change is the signal, so z is preserved), so a
      // small horizontal misregistration between epochs is not read as movement.
      // Refuse a fit whose residual exceeds 10% of the scene span: that means the
      // two clouds never registered, so it's compared as-is rather than shifted.
      // The span is measured in SOURCE units (horizontalSpanXY is unit-agnostic)
      // while the gate option is metres, so convert by the CRS's linear factor —
      // geographic frames don't have one, but alignment refuses those outright.
      const span = horizontalSpanXY(a.positions, a.sourceOrigin);
      const spanUnitToM = frames.horizontalUnitToMetres ?? 1;
      const { after: alignedAfter, alignment } = alignEpochClouds(beforeCloud, afterCloud, {
        maxResidualM: span > 0 ? span * 0.1 * spanUnitToM : undefined, horizontalUnitKnown: frames.horizontalUnitKnown, // one shared verdict: the alignment and the difference below read the SAME frame facts, so a shift reported in metres is never followed by a difference that refuses metres
      });
      const dtms = buildSharedEpochDtms(beforeCloud, alignedAfter);
      if (!dtms) {
        deps.setCompareResult(['Could not compare — a layer has no ground points.']);
        return;
      }
      // Unit factors so cut/fill is m³ and Δz/LoD metres, not source units; a
      // geographic frame has no such factor at all, which `frames` flags so the
      // comparison refuses volumes rather than printing degree² figures as m³.
      const cmp = compareDtms(dtms.before, dtms.after, {
        ...frames, // isGeographic + horizontalUnitKnown + horizontalUnitToMetres, from the two contexts
        verticalUnitToMetres: ctxA.verticalUnitToMetres, // Z keeps its OWN declared scale; the horizontal verdict never stands in for it
      });
      const header = `${baseName(a.name)} (before) → ${baseName(b.name)} (after)`;
      deps.setCompareResult([header, summarizeAlignment(alignment), ...summarizeChange(cmp)]);
      // A georeferenced .asc of the signed difference. The shared grid is built
      // in the common world frame, so its origin IS the scan's projected corner.
      // The .asc grid geometry (cellsize + corners) is in the source LINEAR
      // unit, but detectChange returns Δz in metres. Express the cell values in
      // that same linear unit so the raster is internally consistent (a foot-CRS
      // export otherwise carries foot geometry with metre values, and any GIS
      // volume mixes ft² with m). Metre / compound-metre-horizontal CRS ⇒ 1, a
      // byte-identical no-op; OLV never reprojects, so the grid unit stays source.
      // A provably frame-incompatible pair reports no numbers, so it must not
      // hand out a difference raster either.
      if (cmp.frameIncompatible) {
        deps.setDifferenceAvailable(false);
        return;
      }
      const gridUnitToMetres = frames.horizontalUnitToMetres ?? 1;
      const ascDiff =
        gridUnitToMetres === 1
          ? cmp.result.diff
          : cmp.result.diff.map((v) => v / gridUnitToMetres);
      deps.setLastDifference({
        stem: `${baseName(a.name)}-to-${baseName(b.name)}-difference`,
        asc: () =>
          changeToEsriAscii({
            diff: ascDiff,
            ncols: dtms.cols,
            nrows: dtms.rows,
            cellSizeM: dtms.cellSizeM,
            xllCorner: dtms.before.originH1,
            yllCorner: dtms.before.originH2,
          }),
      });
      deps.setDifferenceAvailable(true);
    } catch (err) {
      deps.setCompareResult([`Compare failed: ${err instanceof Error ? err.message : String(err)}`]);
    }
  })();
}
