/**
 * colorLegend.ts — the colour-legend and scalar-range reads the Viewer answers.
 *
 * Three questions the UI asks about the active scalar colouring: what the
 * legend should say ({@link ColorLegend.activeColorbar}), and the world-unit
 * extents that seed the elevation and intensity filter controls
 * ({@link ColorLegend.elevationExtent}, {@link ColorLegend.intensityExtent}).
 * All three are pure reads over live scene state, so they move out of the
 * Viewer behind a structural {@link ColorLegendHost} and become testable
 * without a WebGL context — the same seam the export adapter uses. `Viewer`
 * keeps thin methods that bind its own state to the host.
 *
 * Every read answers streaming-first, then folds to the first static cloud: a
 * scan is either one streaming source with authoritative header metadata or a
 * set of loaded files. Part of the v0.6 decomposition (see
 * `docs/architecture/architecture-map.md`).
 */

import { rampRangeForMode, type ColorMode } from './colorModes';
import { buildActiveColorbarSpec, type ActiveColorbar } from './activeColorbar';
import { isZUpFormat } from '../io/sniffFormat';
import type { PointCloud } from '../model/PointCloud';
import type { StreamingColorRanges } from './streaming/streamingColors';

/** The streaming slice the legend reads — a structural subset of the session. */
export interface ColorLegendStreaming {
  readonly renderer: {
    readonly colorRanges: StreamingColorRanges;
    readonly colorRangesSeeded: boolean;
  };
  readonly cloud: {
    readonly renderOrigin: readonly [number, number, number];
    dataBounds(): readonly [number, number, number, number, number, number];
  };
}

/**
 * What the legend needs from the live scene. Accessors are functions, not
 * snapshots, so a stored {@link ColorLegend} always reflects the CURRENT scene.
 */
export interface ColorLegendHost {
  activeColorMode(): ColorMode;
  /** The primary (first) static cloud, or null in a streaming-only/empty scene. */
  firstStaticCloud(): PointCloud | null;
  streaming(): ColorLegendStreaming | null;
  heightPercentileTrim(): number;
  /**
   * The project-shared elevation window in WORLD units, or null when the mode
   * is off or fewer than two clouds share the frame. When present the elevation
   * colorbar reports it, so the legend describes the whole project.
   */
  projectSharedElevationRange(): { min: number; max: number } | null;
  /** CRS-resolved elevation unit ('m' / 'ft'), or null when unknown. */
  elevationUnitLabel(): string | null;
  worldUpIsZ(): boolean;
  /** Resident streaming intensity buffers, non-empty only, for the extent scan. */
  residentIntensityBuffers(): readonly ArrayLike<number>[];
}

export interface ColorLegend {
  activeColorbar(): ActiveColorbar | null;
  elevationExtent(): { min: number; max: number } | null;
  intensityExtent(): { min: number; max: number } | null;
}

/** Min/max over one or more intensity buffers, or null when none are finite. */
function intensityRange(
  buffers: readonly ArrayLike<number>[],
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

/** Build the colour-legend / range reads the Viewer delegates to. */
export function buildColorLegend(host: ColorLegendHost): ColorLegend {
  return {
    /**
     * The colorbar for the ACTIVE colour mode, or null when the mode carries
     * no continuous legend. One source for both consumers — the live overlay
     * and the snapshot burn-in — so the exported PNG matches the on-screen
     * legend.
     *
     * Static clouds: the range comes from `rampRangeForMode` (the function
     * `colorForMode` painted with) against the first static cloud; elevation
     * adds the cloud's origin back so the labels read world/source heights.
     *
     * Streaming clouds: ranges are read VERBATIM from the renderer's seeded
     * cloud-global windows — recomputing here would race the reseed. Pre-seed,
     * only elevation is labelable (header cube extent); the other scalar
     * fields are placeholders and yield null. The streaming reseed always
     * clips at the default p5–p95, so the legend reports that fixed window
     * (see StreamingRenderer.onNodeReady).
     */
    activeColorbar(): ActiveColorbar | null {
      const mode = host.activeColorMode();
      const streaming = host.streaming();
      if (streaming) {
        const r = streaming.renderer.colorRanges;
        const seeded = streaming.renderer.colorRangesSeeded;
        // Streaming sources are LAS-derived and Z-up by spec; positions are
        // render-local, so add the render origin's Z back for display.
        const zOff = streaming.cloud.renderOrigin[2];
        let range: { min: number; max: number } | null = null;
        let trim = 0;
        switch (mode) {
          case 'elevation':
            range = { min: r.minZ + zOff, max: r.maxZ + zOff };
            // Seeded window = computeElevationRange defaults (p5–p95);
            // pre-seed = raw header cube (no trim to disclose).
            trim = seeded ? 5 : 0;
            break;
          case 'intensity':
            range = seeded ? { min: r.minIntensity, max: r.maxIntensity } : null;
            break;
          case 'gpsTime':
            range = seeded ? { min: r.minGpsTime, max: r.maxGpsTime } : null;
            // computeScalarRange defaults — see StreamingRenderer.onNodeReady.
            trim = 5;
            break;
          case 'returnNumber':
            range = seeded ? { min: r.minReturnNumber, max: r.maxReturnNumber } : null;
            break;
          default:
            return null;
        }
        return buildActiveColorbarSpec({
          mode,
          range,
          trimPercent: trim,
          elevationUnit: host.elevationUnitLabel(),
        });
      }
      const cloud = host.firstStaticCloud();
      if (!cloud) return null;
      const upAxis = isZUpFormat(cloud.sourceFormat) ? 2 : 1;
      const range = rampRangeForMode(mode, cloud, {
        heightPercentileTrim: host.heightPercentileTrim(),
        upAxis,
      });
      if (!range) return null;
      // Elevation ranges come out in render-local coordinates (the loader
      // subtracted `origin`); add the up-axis origin back so the legend reads
      // true world/source heights — the same reconstruction elevationExtent()
      // performs for the filter controls.
      // When the project-shared scale is on, the legend describes the shared
      // WORLD window (all frame-sharing layers), not this one cloud's ramp.
      const shared = mode === 'elevation' ? host.projectSharedElevationRange() : null;
      const display =
        mode === 'elevation'
          ? (shared ?? {
              min: range.min + cloud.sourceOrigin[upAxis],
              max: range.max + cloud.sourceOrigin[upAxis],
            })
          : range;
      let trimPercent = 0;
      if (mode === 'elevation') trimPercent = host.heightPercentileTrim();
      else if (mode === 'gpsTime') trimPercent = 5;
      return buildActiveColorbarSpec({
        mode,
        range: display,
        trimPercent,
        // The shared window is not this cloud's percentile pass, so its
        // sample count does not describe it.
        sampleCount: shared ? undefined : range.sampleCount,
        elevationUnit: host.elevationUnitLabel(),
      });
    },

    /**
     * The first static cloud's elevation extent in world/source units, along
     * the current up-axis, for seeding the elevation-filter control. `bounds()`
     * is local (origin-shifted), so the world extent adds the cloud's origin
     * back. Streaming falls back to the header data bounds. Null when nothing
     * is loaded, leaving the control to accept typed values.
     */
    elevationExtent(): { min: number; max: number } | null {
      const axisIdx = host.worldUpIsZ() ? 2 : 1;
      const cloud = host.firstStaticCloud();
      if (cloud) {
        const b = cloud.bounds();
        const o = cloud.sourceOrigin[axisIdx];
        return { min: b.min[axisIdx] + o, max: b.max[axisIdx] + o };
      }
      // Streaming: the tight data bounds come from the file header (known at
      // open, stable as nodes stream in), so the control seeds once. Convert
      // the attribute-space bound back to world with the render origin.
      const streaming = host.streaming();
      if (streaming) {
        // Box6 is [minX,minY,minZ, maxX,maxY,maxZ]; the max lives at axisIdx + 3.
        const b = streaming.cloud.dataBounds();
        const o = streaming.cloud.renderOrigin[axisIdx];
        return { min: b[axisIdx] + o, max: b[axisIdx + 3] + o };
      }
      return null;
    },

    /**
     * The first static cloud's intensity min/max, for seeding the intensity-
     * filter control. Null when nothing is loaded or the cloud has no intensity
     * channel. O(n) over the intensity array — run once on load.
     */
    intensityExtent(): { min: number; max: number } | null {
      const inten = host.firstStaticCloud()?.intensity;
      if (inten && inten.length > 0) return intensityRange([inten]);
      // Streaming: LAS headers carry no intensity range, so scan the resident
      // chunks' intensity buffers. Called once when the streaming scan seeds
      // its control, so the O(resident) pass is paid a single time and the
      // extent stays stable even as more nodes stream in.
      if (host.streaming()) {
        const buffers = host.residentIntensityBuffers();
        return buffers.length > 0 ? intensityRange(buffers) : null;
      }
      return null;
    },
  };
}
