/**
 * profileWorkbenchSection.ts
 *
 * What the docked workbench shows: the returns inside a measured corridor,
 * drawn once, with the figures that describe them as text beside the plot.
 *
 * The section comes off `profileSectionSeam`, the one place a profile reads
 * the scene, so the workbench and the chart in the Measurements panel are
 * looking at the same corridor over the same eligible layers. Nothing is
 * re-derived here.
 *
 * Colour, scale and drawing are the existing modules, composed:
 * `colourProfileSection` decides what each return looks like, `fitProfileView`
 * decides what fits, and `ProfileSectionRenderer` draws. This module owns only
 * the joins — the index list, the viewport read off the canvas, and the rows.
 *
 * A canvas states nothing an assistive technology can read, so every figure
 * the plot is drawn from also appears in the detail rows the panel renders as
 * text. That is the same rule the panel itself applies to a selected return.
 *
 * DRAWS ONLY WHAT A CONTEXT ALLOWS. `getContext('2d')` returns null in a test
 * double and in a browser that refuses another context; the composition still
 * produces its rows, and the plot is simply absent rather than throwing on the
 * way to them.
 */

import {
  colourProfileSection,
  type ProfileColourMode,
} from '../render/measure/profileColour';
import {
  fitProfileView,
  type ProfileViewport,
} from '../render/measure/profileViewTransform';
import {
  ProfileSectionRenderer,
  type ProfileRenderingContext,
  type ProfileSurface,
} from '../render/measure/profileSectionRenderer';
import { axisSpanCaption } from '../render/measure/profileAxes';

import type { ProfileWorkbenchDetailRow } from '../ui/ProfileWorkbench';
import type {
  ProfileSectionRequest,
  ProfileSectionResult,
} from '../render/measure/profileSectionSeam';
import type { Vec3 } from '../render/measure/types';

/**
 * Most returns drawn at once.
 *
 * A corridor around one line is small by construction, but a dense scan can
 * still put more returns in it than a plot a few hundred pixels tall can
 * distinguish. Beyond this the section is subsampled at a fixed stride —
 * deterministic, so the same section draws the same picture every time.
 */
export const MAX_DRAWN_RETURNS = 120_000;

/** The colour mode a section opens in. Height is the one every scan carries. */
export const DEFAULT_SECTION_COLOUR_MODE: ProfileColourMode = 'height';

/** Splat and station weights the dock opens at, in CSS pixels. */
const SECTION_STYLE = {
  pointSizePx: 2,
  pointAlpha: 0.85,
  stationWidthPx: 1,
  stationColour: 'rgb(255, 214, 102)',
  stationAlpha: 0.55,
} as const;

/** The canvas the dock hands over, reduced to what is read from it. */
export interface WorkbenchCanvas {
  width: number;
  height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  getContext(id: '2d'): ProfileRenderingContext | null;
}

/** Indices `0 … count-1`, subsampled at a fixed stride past the cap. */
export function drawIndices(count: number, cap: number = MAX_DRAWN_RETURNS): Uint32Array {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return new Uint32Array(0);
  const limit = Math.max(1, Math.floor(cap));
  if (n <= limit) {
    const all = new Uint32Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  const stride = Math.ceil(n / limit);
  const kept = Math.ceil(n / stride);
  const out = new Uint32Array(kept);
  for (let k = 0, i = 0; k < kept; k++, i += stride) out[k] = i;
  return out;
}

/** The extent of the drawn returns, in section space. */
function boundsOf(
  section: ProfileSectionResult,
  indices: Uint32Array,
): { minChainage: number; maxChainage: number; minHeight: number; maxHeight: number } {
  let minC = Infinity;
  let maxC = -Infinity;
  let minH = Infinity;
  let maxH = -Infinity;
  const { chainage, height } = section.points;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    const c = chainage[i]!;
    const h = height[i]!;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  if (!Number.isFinite(minC)) return { minChainage: 0, maxChainage: 0, minHeight: 0, maxHeight: 0 };
  return { minChainage: minC, maxChainage: maxC, minHeight: minH, maxHeight: maxH };
}

/** Everything the panel is told about a composed section. */
export interface WorkbenchSectionView {
  /** The scope sentence the seam composed for this extraction. */
  readonly scope: string;
  /** One polite line about what was drawn. */
  readonly status: string;
  /** The figures behind the plot, as text. */
  readonly detail: ProfileWorkbenchDetailRow[];
  /** Returns actually drawn — fewer than `section.points.count` when capped. */
  readonly drawn: number;
}

export interface ComposeSectionOptions {
  readonly section: ProfileSectionResult;
  readonly canvas: WorkbenchCanvas;
  /** Device pixels per CSS pixel. Absent or non-finite reads as 1. */
  readonly devicePixelRatio?: number;
  /**
   * Unit suffix for the span rows ("m"), or null when the frame cannot state
   * one. A section is measured in the scan's own render units, so a suffix is
   * only truthful alongside the scale that reaches it.
   */
  readonly unitSuffix?: string | null;
  /** Render units to the unit `unitSuffix` names. Absent or non-finite ⇒ 1. */
  readonly unitScale?: number;
  readonly colourMode?: ProfileColourMode;
}

/**
 * Draw `section` onto `canvas` and describe what was drawn.
 *
 * The description is produced whether or not a drawing context was available,
 * because it is the readable half of the same information — a workbench that
 * reported nothing when the plot could not be drawn would leave the reader
 * with an empty panel and no reason for it.
 */
export function composeWorkbenchSection(options: ComposeSectionOptions): WorkbenchSectionView {
  const { section, canvas } = options;
  const unit = options.unitSuffix ?? null;
  const scale =
    Number.isFinite(options.unitScale) && (options.unitScale as number) > 0
      ? (options.unitScale as number)
      : 1;
  const indices = drawIndices(section.points.count);
  const colours = new Uint8Array(indices.length * 3);
  const colouring = colourProfileSection(
    {
      points: section.points,
      mode: options.colourMode ?? DEFAULT_SECTION_COLOUR_MODE,
      indices,
    },
    colours,
  );

  const bounds = boundsOf(section, indices);
  const viewport: ProfileViewport = {
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    devicePixelRatio: options.devicePixelRatio ?? 1,
  };
  // `fit` claims no ratio, which is the honest mode for a plot whose box the
  // user drags: a stated exaggeration would need both unit scales AND a box
  // that does not change under it.
  const view = fitProfileView(bounds, viewport, { kind: 'fit' }, {
    horizontalToMetres: null,
    verticalToMetres: null,
  });

  const ctx = canvas.getContext('2d');
  if (ctx && view) {
    const surface: ProfileSurface = {
      ctx,
      setBackingSize: (deviceWidth, deviceHeight) => {
        canvas.width = deviceWidth;
        canvas.height = deviceHeight;
      },
    };
    // Drawn immediately rather than through a scheduler: this runs once per
    // open, and the panel has nothing to show until it has.
    const renderer = new ProfileSectionRenderer(surface, (draw) => draw());
    renderer.setFrame({
      scene: { points: section.points, indices, colours, stations: null },
      view,
      viewport,
      style: SECTION_STYLE,
    });
    renderer.renderNow();
  }

  const detail: ProfileWorkbenchDetailRow[] = [
    { label: 'Returns in corridor', value: String(section.points.count) },
    { label: 'Drawn', value: String(indices.length) },
    { label: 'Corridor half-width', value: axisSpanCaption(section.band * scale, unit) },
    {
      label: 'Chainage span',
      value: axisSpanCaption((bounds.maxChainage - bounds.minChainage) * scale, unit),
    },
    {
      label: 'Height span',
      value: axisSpanCaption((bounds.maxHeight - bounds.minHeight) * scale, unit),
    },
    { label: 'Sources', value: String(section.sources.length) },
    { label: 'Colour', value: colouring.legend.kind === 'unavailable' ? 'unavailable' : colouring.mode },
  ];

  const status =
    section.points.count === 0
      ? 'No returns fell inside this corridor.'
      : indices.length < section.points.count
        ? `Showing ${indices.length} of ${section.points.count} returns.`
        : `Showing ${section.points.count} returns.`;

  return { scope: section.scopeLabel, status, detail, drawn: indices.length };
}

/** What the presenter needs to read a section out of the live scene. */
export interface WorkbenchSectionScene {
  /** The measurement's render-space endpoints and corridor, or null. */
  profile(id: string): {
    a: Vec3;
    b: Vec3;
    corridorWidth: number | null;
  } | null;
  section(request: ProfileSectionRequest): ProfileSectionResult | null;
  /** Render units to metres, or null when the frame cannot state a unit. */
  metresPerUnit(): number | null;
  devicePixelRatio(): number;
}

/**
 * Draw one measurement's section into a mounted dock.
 *
 * Every refusal leaves the panel with a sentence rather than an empty plot: a
 * measurement whose endpoints are gone says so, and a scene with no eligible
 * layer says that instead of drawing nothing and explaining nothing.
 */
export function presentWorkbenchSection(
  handle: {
    canvas: HTMLCanvasElement;
    setScope(text: string): void;
    setStatus(text: string): void;
    setDetail(rows: readonly ProfileWorkbenchDetailRow[] | null): void;
  },
  id: string,
  scene: WorkbenchSectionScene,
): void {
  const profile = scene.profile(id);
  if (!profile) {
    handle.setStatus('This profile no longer has two endpoints to section.');
    return;
  }
  const section = scene.section({
    a: profile.a,
    b: profile.b,
    corridorWidth: profile.corridorWidth,
  });
  if (!section) {
    handle.setStatus('No layer is currently eligible for a section.');
    return;
  }
  // A unit is stated only alongside the scale that reaches it: a section is
  // measured in the scan's own render units, and a foot-CRS scan labelled "m"
  // without the factor would read as metres it never was.
  const metres = scene.metresPerUnit();
  const view = composeWorkbenchSection({
    section,
    canvas: handle.canvas as unknown as WorkbenchCanvas,
    devicePixelRatio: scene.devicePixelRatio(),
    unitSuffix: metres === null ? null : 'm',
    unitScale: metres ?? 1,
  });
  handle.setScope(view.scope);
  handle.setStatus(view.status);
  handle.setDetail(view.detail);
}
