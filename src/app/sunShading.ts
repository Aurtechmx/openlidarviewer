/**
 * sunShading.ts: sun shading on the elevation colours of loaded scans.
 *
 * Owns the settings, one direction code per point and layer (two bytes a
 * point: a sun or strength change then needs no new pass), and the one job
 * that computes them. A layer's codes depend on its positions, which never
 * change, and on its up axis and vertical unit, so they are dropped when a CRS
 * change moves either, and when the layer closes. Class edits, class
 * visibility, the filters and the clip do not enter: those hide points, and
 * the colour of a shown point is the same.
 *
 * Display only. Measurements, analyses and exports of points read positions.
 * Loaded lazily with the Height controls (lazyChunks.ts `loadSunShading`).
 */

import type { PointCloud } from '../model/PointCloud';
import type { Viewer } from '../render/Viewer';
import { sourcePositions } from '../model/pointFrames';
import { spatialContextFrom, verticalMetresPerUnit } from '../geo/SpatialContext';
import { peekCloudUpAxisIndex } from '../render/layerUpRegistry';
import { layerCrsOf, type LayerFrameCrs } from './layerUpFrames';
import { setElevationShade } from '../render/sunShading/elevationShade';
import { buildSunTable, cleanSun, DEFAULT_SUN, shadeRgb, type SunSettings } from '../render/sunShading/sunTable';
import { SUN_STREAMING_REASON } from '../render/sunShading/streamingReason';
import type { SurfaceFrame } from '../render/sunShading/surfaceNormals';
import { computeSunNormals, NoSurfaceError } from '../render/sunShading/sunNormalsWorkerClient';
import { createSunShadingControl, type SunShadingControl } from '../ui/inspector/sunShadingControl';

export type SunViewer = Pick<Viewer,
  'clouds' | 'getCloud' | 'colorModeOf' | 'isStreamingActive' | 'refreshProjectSharedElevation' | 'requestFrame' | 'onColorContextChanged'>;

/** What the shell hands over. */
export interface SunShadingHost {
  readonly viewer: SunViewer;
  readonly crs: LayerFrameCrs & { subscribe(listener: () => void): () => void };
  readonly activeId: () => string | null;
}

export const SHADED_NOTE = 'sun shading on: slopes are lighter or darker than the ramp';
const DEGREES_REASON = 'Sun shading is off for this scan: its coordinates are degrees, so slopes cannot be worked out.';
const UNIT_REASON = 'Sun shading is off for this scan: its height unit cannot be read.';
const NO_SURFACE_REASON = 'Sun shading is off for this scan: it has too few points to form a surface.';
const FAILED_REASON = 'Sun shading could not run in this browser. The colours are unchanged.';
/** A repaint slower than this waits for the slider to rest. */
const SLOW_REPAINT_MS = 120;

/** The frame a layer is lit in, or why it cannot be. */
export function sunFrameOf(cloud: PointCloud, crs: LayerFrameCrs, active: boolean): SurfaceFrame | { readonly refusal: string } {
  const layer = layerCrsOf(crs, cloud, active);
  if (layer && 'kind' in layer && layer.kind === 'geographic') return { refusal: DEGREES_REASON };
  const ctx = spatialContextFrom(layer as Parameters<typeof spatialContextFrom>[0]);
  const v = verticalMetresPerUnit(ctx, 'horizontal');
  const h = ctx.linearUnitToMetres;
  if (v === undefined || !(h > 0) || !Number.isFinite(h)) return { refusal: UNIT_REASON };
  return { upAxis: peekCloudUpAxisIndex(cloud), verticalScale: v / h };
}

interface Entry {
  readonly cloud: PointCloud;
  readonly key: string;
  codes: Uint16Array | null;
  refusal: string | null;
}

export interface SunShading {
  readonly settings: SunSettings;
  set(patch: Partial<SunSettings>): void;
  /** Stop the running pass and switch shading off. */
  cancel(): void;
  /** Codes held, in bytes (diagnostic). */
  heldBytes(): number;
  dispose(): void;
}

/** Build the controller. `compute` is injected by tests. */
export function createSunShading(
  host: SunShadingHost,
  report: (s: { status: string; busy: boolean; enabled: boolean; settings: SunSettings }) => void,
  compute: typeof computeSunNormals = computeSunNormals,
): SunShading {
  const { viewer } = host;
  let settings: SunSettings = DEFAULT_SUN;
  let table: Float32Array | null = null;
  const entries = new Map<string, Entry>();
  let job: { readonly entry: Entry; readonly abort: AbortController; share: number } | null = null;
  let painted = ''; // what the last repaint showed
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cost = 0;
  let disposed = false;

  const on = (): boolean => table !== null && !viewer.isStreamingActive();
  const heightLayers = (): [string, PointCloud][] => viewer.clouds().flatMap((id) => {
    const cloud = viewer.getCloud(id);
    return cloud && viewer.colorModeOf(id) === 'elevation' ? [[id, cloud] as [string, PointCloud]] : [];
  });

  setElevationShade({
    shade(cloud, rgb) {
      if (!table || !on()) return;
      for (const e of entries.values()) {
        if (e.cloud === cloud && e.codes) { shadeRgb(rgb, e.codes, table); return; }
      }
    },
    note: () => (on() && heightLayers().some(([id]) => entries.get(id)?.codes) ? SHADED_NOTE : null),
  });

  function repaint(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const t = performance.now();
    viewer.refreshProjectSharedElevation(true);
    viewer.requestFrame();
    cost = performance.now() - t;
  }

  /** Repaint when what is shown differs from what the state says. */
  function paintIfChanged(): void {
    const shown = on() ? [...entries].filter(([, e]) => e.codes).map(([id, e]) => `${id}:${e.key}`).join('|') : '';
    if (shown === painted) return;
    painted = shown;
    repaint();
  }

  function say(): void {
    const streaming = viewer.isStreamingActive();
    let status = '';
    if (streaming) status = SUN_STREAMING_REASON;
    else if (job) status = `Working out surface directions: ${Math.floor(job.share * 5) * 20}%`;
    else if (table) status = heightLayers().map(([id]) => entries.get(id)?.refusal).find((r) => r) ?? '';
    report({ status, busy: job !== null, enabled: !streaming, settings });
  }

  function sync(): void {
    if (disposed) return;
    const layers = heightLayers();
    const open = new Set(viewer.clouds());
    for (const [id, e] of entries) {
      if (!open.has(id) || viewer.getCloud(id) !== e.cloud) entries.delete(id);
    }
    if (on()) {
      for (const [id, cloud] of layers) {
        const frame = sunFrameOf(cloud, host.crs, id === host.activeId());
        const key = JSON.stringify(frame);
        if (entries.get(id)?.key === key) continue;
        entries.set(id, { cloud, key, codes: null, refusal: 'refusal' in frame ? frame.refusal : null });
      }
    }
    if (job && (!on() || ![...entries.values()].includes(job.entry))) job.abort.abort();
    paintIfChanged();
    if (on() && !job) startNext(layers);
    say();
  }

  function startNext(layers: readonly [string, PointCloud][]): void {
    const next = layers.map(([id]) => entries.get(id)).find((e) => e && !e.codes && !e.refusal);
    if (!next) return;
    const run = { entry: next, abort: new AbortController(), share: 0 };
    job = run;
    const frame = JSON.parse(next.key) as SurfaceFrame;
    compute(sourcePositions(next.cloud), frame, run.abort.signal, (share) => { run.share = share; say(); })
      .then(
        (codes) => { if (!run.abort.signal.aborted) next.codes = codes; },
        (err: unknown) => {
          if (run.abort.signal.aborted) return;
          if (!(err instanceof NoSurfaceError)) console.warn('[sun shading]', err);
          next.refusal = err instanceof NoSurfaceError ? NO_SURFACE_REASON : FAILED_REASON;
        },
      )
      .finally(() => { job = null; sync(); });
  }

  // The Viewer reports a mode, layer, trim or stream change through one
  // callback, which the shell already uses for the legend: run after it.
  const legend = viewer.onColorContextChanged;
  const chained = (): void => { legend?.(); sync(); };
  viewer.onColorContextChanged = chained;
  const offCrs = host.crs.subscribe(() => sync());

  return {
    get settings() { return settings; },
    set(patch) {
      const was = table !== null;
      settings = cleanSun({ ...settings, ...patch });
      table = settings.strength > 0 ? buildSunTable(settings) : null;
      if (was !== (table !== null)) { sync(); return; }
      say();
      if (!table) return;
      // Same layers, new light: coalesce a drag to one repaint a frame, or to
      // its end when a repaint is slow.
      if (timer !== undefined) {
        if (cost <= SLOW_REPAINT_MS) return;
        clearTimeout(timer);
      }
      timer = setTimeout(repaint, cost > SLOW_REPAINT_MS ? SLOW_REPAINT_MS : 16);
    },
    cancel() { this.set({ strength: 0 }); },
    heldBytes: () => [...entries.values()].reduce((s, e) => s + (e.codes?.byteLength ?? 0), 0),
    dispose() {
      if (disposed) return;
      disposed = true;
      job?.abort.abort();
      if (timer !== undefined) clearTimeout(timer);
      table = null;
      entries.clear();
      setElevationShade(null);
      offCrs();
      if (viewer.onColorContextChanged === chained) viewer.onColorContextChanged = legend;
    },
  };
}

/** Mount the controls in `slot` and drive them. */
export function mountSunShading(slot: HTMLElement, host: SunShadingHost): SunShading {
  let control: SunShadingControl | null = null;
  const shading = createSunShading(host, (s) => control?.show(s));
  control = createSunShadingControl({ onChange: (p) => shading.set(p), onCancel: () => shading.cancel() });
  slot.replaceChildren(control.element);
  shading.set({});
  return shading;
}
