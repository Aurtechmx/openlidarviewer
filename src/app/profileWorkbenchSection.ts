/**
 * profileWorkbenchSection.ts
 *
 * What the docked workbench shows: the returns inside a measured corridor,
 * with the figures that describe them as text beside the plot.
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
 * THE CORRIDOR IS WALKED ACROSS FRAMES, AND SO IS THE DISPLAY SELECTION.
 * `sectionChunks` yields the count examined so far and
 * `selectProfileSectionLodChunks` yields the steps it has taken; both are
 * consumed here under the same millisecond budget and through the same
 * scheduler, so neither a dense cloud nor the section it produces holds the
 * main thread with the dock already mounted and empty.
 *
 * THE PLOT REDRAWS WHEN ITS BOX CHANGES. A dock restored collapsed has no
 * canvas box at all, a splitter drag changes it, and so does a window resize;
 * a picture drawn once at the first of those sizes is blank or stretched at
 * every later one.
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
  profileDataToScreen,
} from '../render/measure/profileViewTransform';
import {
  ProfileSectionRenderer,
  type ProfileRenderingContext,
  type ProfileSurface,
} from '../render/measure/profileSectionRenderer';
import {
  describeClassBasis,
  GROUND_BASIS_UNVERIFIED_NOTE,
} from '../render/measure/profileProvenance';
import {
  axisSpanCaption,
  fitAxisLabels,
  profileAxes,
} from '../render/measure/profileAxes';
import {
  selectProfileSectionLod,
  selectProfileSectionLodChunks,
} from '../render/measure/profileSectionLod';
import {
  buildProfileHitTestIndex,
  queryProfileHitTest,
} from '../render/measure/profileHitTest';
import { buildProfilePointDetail } from '../render/measure/profilePointDetail';
import {
  profileDetailSources,
  profileHoverReadout,
  profileLinkStatusText,
  profileMarkerSize,
  profileReturnIdentity,
} from '../render/measure/profilePointLink';
import { drawProfileLinkOverlay } from '../render/measure/profileLinkOverlay2d';
import { pointVerticalReference } from '../render/pointInfo';
import { createProfileLinkController } from './profileLinkController';

import type { ProfileWorkbenchDetailRow } from '../ui/ProfileWorkbench';
import type { ProfileHitTestIndex } from '../render/measure/profileHitTest';
import type { ProfileView, ProfileViewport } from '../render/measure/profileViewTransform';
import type { ProfileAxesModel } from '../render/measure/profileAxes';
import type { VerticalReference } from '../geo/height';
import type { ProfileLinkOverlayContext } from '../render/measure/profileLinkOverlay2d';
import type { ProfileLinkController, ProfileLinkMarker } from './profileLinkController';
import type {
  ProfileReturnLocation,
  ProfileReturnRef,
  ProfileSectionRequest,
  ProfileSectionResult,
} from '../render/measure/profileSectionSeam';
import type { Vec3 } from '../render/measure/types';
import type { ResolvedCrs } from '../geo/CoordinateTypes';

/**
 * Most returns drawn at once.
 *
 * A corridor around one line is small by construction, but a dense scan can
 * still put more returns in it than a plot a few hundred pixels tall can
 * distinguish. Beyond this the section is stratified by
 * `selectProfileSectionLod`, which spends the budget per occupied region of
 * the section rather than per return, so a thin ground band and a rare class
 * both survive a cap that a stride would have thinned them out of. The
 * selection is a pure function of the section and the cap, so the same
 * section draws the same picture every time.
 */
export const MAX_DRAWN_RETURNS = 120_000;

/** The colour mode a section opens in. Height is the one every scan carries. */
export const DEFAULT_SECTION_COLOUR_MODE: ProfileColourMode = 'height';

/** Points the seam examines, and steps the selection takes, between yields. */
export const SECTION_CHUNK_SIZE = 64_000;

/**
 * Milliseconds one slice may hold the main thread.
 *
 * One budget for both stages. The corridor walk and the display selection run
 * back to back on the same thread over the same section, so a budget that
 * covered only the first would leave the second free to stall exactly the
 * frame the first was broken up to protect.
 */
export const SLICE_BUDGET_MS = 8;

/** What the panel says while the corridor is still being walked. */
export const SECTION_WORKING_STATUS = 'Reading the returns inside this corridor.';

/** Splat and station weights the dock opens at, in CSS pixels. */
const SECTION_STYLE = {
  pointSizePx: 2,
  pointAlpha: 0.85,
  stationWidthPx: 1,
  stationColour: 'rgb(255, 214, 102)',
  stationAlpha: 0.55,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Axis indicators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tick label size, CSS pixels.
 *
 * Fixed rather than read from the stylesheet: the labels are drawn into a
 * canvas, and a canvas has no cascade to read a token out of. The value is the
 * one `--text-xs` resolves to for the panel around it, so the plot's numbers
 * and the detail list's numbers are the same size on screen.
 */
export const AXIS_FONT_PX = 11;

/** How far a label sits from the edge of the plot it labels, CSS pixels. */
export const AXIS_LABEL_INSET_PX = 4;

/**
 * Rule, label and title inks.
 *
 * The axes are drawn OVER the plot rather than in a gutter carved out of it.
 * Carving would change the box `fitProfileView` is given, so the picture a
 * reader has been looking at would shift the moment an axis appeared. Drawing
 * over it means the ink has to stay quieter than the returns underneath: the
 * rules read as a grid behind the section, not as another series in it.
 */
const AXIS_RULE_COLOUR = 'rgba(255, 255, 255, 0.10)';
const AXIS_TEXT_COLOUR = 'rgba(255, 255, 255, 0.62)';
const AXIS_TITLE_COLOUR = 'rgba(255, 255, 255, 0.45)';

/** Target major ticks per axis. Fewer than the plot could hold, so labels fit. */
export const AXIS_TARGET_TICKS = 6;

/**
 * The 2D context, with the text calls the axis needs.
 *
 * Separate from `ProfileRenderingContext` because that one is the splat
 * renderer's contract and states only what the splats use. Every text member
 * is feature-detected before it is called, so a context without them (an
 * older test double, a stub surface) draws the rules and skips the words
 * rather than throwing on the way.
 */
export interface AxisTextContext extends ProfileRenderingContext {
  font: string;
  textAlign: string;
  textBaseline: string;
  fillText(text: string, x: number, y: number): void;
}

function canDrawText(ctx: ProfileRenderingContext): ctx is AxisTextContext {
  return typeof (ctx as Partial<AxisTextContext>).fillText === 'function';
}

/**
 * Draw both axes over a plot that has already been rendered.
 *
 * The ticks come from `profileAxes`, so a rule here falls exactly where the
 * same transform put the returns beside it, and every tick is an exact
 * multiple of its step. Which labels are actually printed comes from
 * `fitAxisLabels`, so a narrow dock loses labels rather than stacking them
 * into an unreadable smear.
 *
 * The height axis is titled by what the scan supports and nothing more: a
 * section with no declared datum reads "Height (datum unknown)" here for the
 * same reason it does in the point inspector and on the exported sheet.
 */
export function drawWorkbenchAxes(
  ctx: ProfileRenderingContext,
  axes: ProfileAxesModel,
  viewport: ProfileViewport,
): void {
  const width = viewport.width;
  const height = viewport.height;
  if (!(width > 0) || !(height > 0)) return;

  ctx.globalAlpha = 1;
  ctx.strokeStyle = AXIS_RULE_COLOUR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of axes.x.pixels) {
    if (!Number.isFinite(x) || x < 0 || x > width) continue;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (const y of axes.y.pixels) {
    if (!Number.isFinite(y) || y < 0 || y > height) continue;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  if (!canDrawText(ctx)) return;
  const text = ctx;
  text.font = `${AXIS_FONT_PX}px system-ui, sans-serif`;

  // Chainage labels run along the bottom edge; the strip they compete for is
  // the plot's width.
  const keepX = fitAxisLabels({
    labels: axes.x.labels,
    pixels: axes.x.pixels,
    containerPx: width,
    fontPx: AXIS_FONT_PX,
  });
  text.fillStyle = AXIS_TEXT_COLOUR;
  text.textAlign = 'center';
  text.textBaseline = 'bottom';
  for (let i = 0; i < axes.x.labels.length; i++) {
    if (!keepX[i]) continue;
    text.fillText(axes.x.labels[i]!, axes.x.pixels[i]!, height - AXIS_LABEL_INSET_PX);
  }

  // Height labels are stacked down the left edge, so what one of them can
  // collide with is the LINE HEIGHT of its neighbour, never its width.
  const keepY = fitAxisLabels({
    labels: axes.y.labels,
    pixels: axes.y.pixels,
    containerPx: height,
    fontPx: AXIS_FONT_PX,
    extentPx: () => AXIS_FONT_PX,
  });
  text.textAlign = 'left';
  text.textBaseline = 'middle';
  for (let i = 0; i < axes.y.labels.length; i++) {
    if (!keepY[i]) continue;
    text.fillText(axes.y.labels[i]!, AXIS_LABEL_INSET_PX, axes.y.pixels[i]!);
  }

  // The titles carry the units, because a tick label is a bare number and an
  // axis holds one unit down its whole column.
  text.fillStyle = AXIS_TITLE_COLOUR;
  text.textAlign = 'right';
  text.textBaseline = 'bottom';
  text.fillText(axes.x.title, width - AXIS_LABEL_INSET_PX, height - AXIS_LABEL_INSET_PX);
  text.textAlign = 'left';
  text.textBaseline = 'top';
  text.fillText(axes.y.title, AXIS_LABEL_INSET_PX, AXIS_LABEL_INSET_PX);
}

/** The canvas the dock hands over, reduced to what is read from it. */
export interface WorkbenchCanvas {
  width: number;
  height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  getContext(id: '2d'): ProfileRenderingContext | null;
}

/** The returns a section draws: every one under the cap, a stratified sample above it. */
export function drawIndices(
  section: ProfileSectionResult,
  cap: number = MAX_DRAWN_RETURNS,
): Uint32Array {
  return selectProfileSectionLod(section.points, { cap, chunkSize: SECTION_CHUNK_SIZE });
}

/**
 * The extent of the section, over EVERY accepted return.
 *
 * Not over the drawn subset. The display cap decides how much of a dense
 * corridor is worth splatting, and a span derived from it understates the
 * corridor by however much the stride skipped — while sitting in the same
 * list as "Returns in corridor: N". A figure presented as a property of the
 * section has to be measured over the section.
 */
function boundsOf(
  section: ProfileSectionResult,
): { minChainage: number; maxChainage: number; minHeight: number; maxHeight: number } {
  let minC = Infinity;
  let maxC = -Infinity;
  let minH = Infinity;
  let maxH = -Infinity;
  const { chainage, height, count } = section.points;
  for (let i = 0; i < count; i++) {
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
  /**
   * What a missing classification means for the heights, or null when every
   * source carried one. The exported sheet has always stated this basis; the
   * note exists so a reader working on screen is told the same thing without
   * having to export a PDF to find it.
   */
  readonly groundBasisNote: string | null;
  /** One polite line about what was drawn. */
  readonly status: string;
  /** The figures behind the plot, as text. */
  readonly detail: ProfileWorkbenchDetailRow[];
  /** Returns actually drawn — fewer than `section.points.count` when capped. */
  readonly drawn: number;
}

/** The placement the last draw used, so a hit-test can agree with the picture. */
export interface WorkbenchPlotFrame {
  readonly view: ProfileView;
  readonly viewport: ProfileViewport;
}

/** A composed section, with the means to draw it again at a new size. */
export interface WorkbenchSectionPlot {
  readonly view: WorkbenchSectionView;
  /** The section indices actually drawn, in draw order. */
  readonly indices: Uint32Array;
  /** Draw at the canvas's current box. A box with no area draws nothing. */
  draw(): void;
  /**
   * The view and viewport the last successful draw used, or null when nothing
   * has been drawn.
   *
   * Published rather than kept private because a hit-test has to be built over
   * the SAME placement the picture was drawn with. Re-deriving it from the
   * canvas would be a second `fitProfileView` call that a resize between the
   * two could make disagree, and a hover would then name a return the reader
   * is not pointing at.
   */
  frame(): WorkbenchPlotFrame | null;
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
  /**
   * The returns to draw, when the caller has already chosen them.
   *
   * The presenter walks {@link selectProfileSectionLodChunks} across frames
   * and hands the answer over here, so the selection is not paid twice.
   * Absent, this composes the same selection in one pass.
   */
  readonly indices?: Uint32Array;
  /**
   * Vertical reference of the section's heights, for the height-axis title.
   *
   * Absent reads as `unknown`, which titles the axis "Height (datum unknown)".
   * That is the honest default for a caller that has not resolved a CRS: the
   * axis must never promise a datum the section cannot show one for.
   */
  readonly reference?: VerticalReference;
}

/**
 * Compose `section` against `canvas`, draw it once, and hand back both the
 * description and the means to draw it again.
 *
 * The description is produced whether or not a drawing context was available,
 * because it is the readable half of the same information — a workbench that
 * reported nothing when the plot could not be drawn would leave the reader
 * with an empty panel and no reason for it.
 */
export function prepareWorkbenchSection(options: ComposeSectionOptions): WorkbenchSectionPlot {
  const { section, canvas } = options;
  const unit = options.unitSuffix ?? null;
  const scale =
    Number.isFinite(options.unitScale) && (options.unitScale as number) > 0
      ? (options.unitScale as number)
      : 1;
  const reference: VerticalReference = options.reference ?? 'unknown';
  const axisUnit = scale === 1 ? unit : null;
  const indices = options.indices ?? drawIndices(section);
  const colours = new Uint8Array(indices.length * 3);
  const colouring = colourProfileSection(
    {
      points: section.points,
      mode: options.colourMode ?? DEFAULT_SECTION_COLOUR_MODE,
      indices,
    },
    colours,
  );

  const bounds = boundsOf(section);
  const devicePixelRatio = options.devicePixelRatio ?? 1;

  const ctx = canvas.getContext('2d');
  const surface: ProfileSurface | null = ctx
    ? {
        ctx,
        setBackingSize: (deviceWidth, deviceHeight) => {
          canvas.width = deviceWidth;
          canvas.height = deviceHeight;
        },
      }
    : null;
  // Drawn through the immediate scheduler: every draw here is already a
  // response to something that happened, and the panel has nothing to show
  // until it has run.
  const renderer = surface ? new ProfileSectionRenderer(surface, (draw) => draw()) : null;

  let lastFrame: WorkbenchPlotFrame | null = null;

  function draw(): void {
    if (!renderer || !ctx) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    // A collapsed dock's body is `display: none`, so its canvas reads 0x0.
    // Sizing a backing store from that leaves one device pixel of plot behind,
    // and one device pixel is what an expand would then be showing.
    if (!(width > 0) || !(height > 0)) return;
    const viewport: ProfileViewport = { width, height, devicePixelRatio };
    // `fit` claims no ratio, which is the honest mode for a plot whose box the
    // user drags: a stated exaggeration would need both unit scales AND a box
    // that does not change under it.
    const view = fitProfileView(bounds, viewport, { kind: 'fit' }, {
      horizontalToMetres: null,
      verticalToMetres: null,
    });
    if (!view) return;
    renderer.setFrame({
      scene: { points: section.points, indices, colours, stations: null },
      view,
      viewport,
      style: SECTION_STYLE,
    });
    renderer.renderNow();
    // After the returns, so the grid sits over the section rather than under
    // splats that would hide the rules the reader is measuring against.
    drawWorkbenchAxes(
      ctx,
      profileAxes(view, viewport, {
        reference,
        // Ticks are read off the section in the scan's OWN render units, so a
        // unit is named only where those units already ARE that unit. On a
        // frame whose scale is not 1 the detail rows still carry the converted
        // spans; the axis prints bare numbers rather than metres it is not in.
        horizontalUnit: axisUnit,
        verticalUnit: axisUnit,
        units: { horizontalToMetres: null, verticalToMetres: null },
        targetXTicks: AXIS_TARGET_TICKS,
        targetYTicks: AXIS_TARGET_TICKS,
      }),
      viewport,
    );
    lastFrame = { view, viewport };
  }

  draw();

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

  return {
    view: {
      // The class clause joins the scope sentence rather than standing apart,
      // because both answer the one question a reader has about the plot:
      // what was read, and what could be excluded from it.
      scope: `${section.scopeLabel} · ${describeClassBasis(section.classificationOnEverySource)}`,
      groundBasisNote: section.classificationOnEverySource
        ? null
        : GROUND_BASIS_UNVERIFIED_NOTE,
      status,
      detail,
      drawn: indices.length,
    },
    indices,
    draw,
    frame: () => lastFrame,
  };
}

/** {@link prepareWorkbenchSection}, for a caller that draws only once. */
export function composeWorkbenchSection(options: ComposeSectionOptions): WorkbenchSectionView {
  return prepareWorkbenchSection(options).view;
}

/** What the presenter needs to read a section out of the live scene. */
export interface WorkbenchSectionScene {
  /** The measurement's render-space endpoints and corridor, or null. */
  profile(id: string): {
    a: Vec3;
    b: Vec3;
    corridorWidth: number | null;
  } | null;
  /**
   * The corridor walk, yielding the count examined so far.
   *
   * The generator rather than the run-to-completion `section()`: every point
   * of every eligible layer is tested, and doing that in one pass freezes the
   * app with the dock already mounted and empty.
   */
  sectionChunks(
    request: ProfileSectionRequest,
  ): Generator<number, ProfileSectionResult | null, void>;
  /** Render units to metres, or null when the frame cannot state a unit. */
  metresPerUnit(): number | null;
  devicePixelRatio(): number;
  /** Run the next slice of the walk. Absent ⇒ a frame callback. */
  scheduleSlice?(run: () => void): void;
  /** Milliseconds elapsed, for the slice budget. Absent ⇒ `Date.now`. */
  now?(): number;
  /** Watch the plot's box. Absent ⇒ a `ResizeObserver` on the canvas. */
  observeCanvasSize?(canvas: HTMLCanvasElement, onChange: () => void): () => void;
  /**
   * The CURRENT project-frame coordinate of one recorded source point.
   *
   * `viewer.profileSeam.locateReturn`. Absent leaves the plot exactly as it
   * was before this existed: hover and click still read the section, and no
   * mark is placed in 3D, because there is nothing to route the identity
   * through.
   */
  locateReturn?(ref: ProfileReturnRef, out: Float64Array): ProfileReturnLocation;
  /** Place or clear the 3D mark. Absent ⇒ the link is 2D only. */
  markLinkedReturn?(marker: (ProfileLinkMarker & { readonly size: number }) | null): void;
  /**
   * Move the camera onto a point.
   *
   * Reached ONLY from a deliberate focus action on a clicked selection. A
   * hover has no path to it, which is why it is not part of the marker call.
   */
  focusPoint?(position: readonly [number, number, number]): void;
  /** Resolved CRS of the section frame, for the height wording. */
  crs?(): ResolvedCrs | undefined;
  /** Subscribe to pointer input on the plot. Absent ⇒ DOM listeners. */
  observePointer?(canvas: HTMLCanvasElement, handlers: WorkbenchPointerHandlers): () => void;
  /** One frame for the pointer flush. Absent ⇒ a frame callback. */
  schedulePointerFlush?(run: () => void): void;
}

/** What the plot does with pointer input, independent of how it arrives. */
export interface WorkbenchPointerHandlers {
  move(xPx: number, yPx: number): void;
  leave(): void;
  click(xPx: number, yPx: number): void;
  /**
   * The deliberate focus gesture: lock the return under the pointer AND move
   * the camera onto it.
   *
   * A separate entry from `click` because the camera is exactly what a hover
   * must never do. Hover and click each have their own way in, and only this
   * one reaches a camera at all.
   */
  focus(xPx: number, yPx: number): void;
}

/** A frame if the host has one, a task otherwise. */
function scheduleFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
  else setTimeout(run, 0);
}

/** A `ResizeObserver` where there is one; an inert subscription otherwise. */
function observeElementSize(canvas: HTMLCanvasElement, onChange: () => void): () => void {
  if (typeof ResizeObserver !== 'function') return () => {};
  const observer = new ResizeObserver(() => onChange());
  observer.observe(canvas);
  return () => observer.disconnect();
}

/**
 * Draw one measurement's section into a mounted dock, and keep it drawn.
 *
 * Every refusal leaves the panel with a sentence rather than an empty plot: a
 * measurement whose endpoints are gone says so, and a scene with no eligible
 * layer says that instead of drawing nothing and explaining nothing.
 *
 * The returned function releases the size subscription and abandons a walk
 * still in flight, so a dock replaced or closed mid-extraction stops working
 * for a plot nobody is looking at.
 */
export function presentWorkbenchSection(
  handle: {
    canvas: HTMLCanvasElement;
    overlay?: HTMLCanvasElement;
    setScope(text: string): void;
    setGroundBasis(note: string | null): void;
    setStatus(text: string): void;
    setDetail(rows: readonly ProfileWorkbenchDetailRow[] | null): void;
    setReadout?(text: string | null): void;
  },
  id: string,
  scene: WorkbenchSectionScene,
): () => void {
  let stopped = false;
  let releaseSize: (() => void) | null = null;
  let link: SectionPointLink | null = null;
  // The seam reads this on every chunk boundary, so abandoning the walk costs
  // one more chunk rather than the rest of the scene.
  const signal = { aborted: false };

  function dispose(): void {
    stopped = true;
    signal.aborted = true;
    releaseSize?.();
    releaseSize = null;
    // Takes the 3D mark with it: a dock that is gone must not leave a cross
    // standing in the scene over a section nobody can see any more.
    link?.release();
    link = null;
  }

  const profile = scene.profile(id);
  if (!profile) {
    handle.setStatus('This profile no longer has two endpoints to section.');
    return dispose;
  }

  handle.setStatus(SECTION_WORKING_STATUS);
  const walk = scene.sectionChunks({
    a: profile.a,
    b: profile.b,
    corridorWidth: profile.corridorWidth,
    chunkSize: SECTION_CHUNK_SIZE,
    signal,
  });
  const now = scene.now ?? Date.now;
  const schedule = scene.scheduleSlice ?? scheduleFrame;

  function finish(section: ProfileSectionResult, indices: Uint32Array): void {
    // A unit is stated only alongside the scale that reaches it: a section is
    // measured in the scan's own render units, and a foot-CRS scan labelled
    // "m" without the factor would read as metres it never was.
    const metres = scene.metresPerUnit();
    const plot = prepareWorkbenchSection({
      section,
      indices,
      canvas: handle.canvas as unknown as WorkbenchCanvas,
      devicePixelRatio: scene.devicePixelRatio(),
      unitSuffix: metres === null ? null : 'm',
      unitScale: metres ?? 1,
      // The SAME reference the detail card's height row is worded from, so the
      // axis title and the row beside it cannot name two different surfaces.
      reference: pointVerticalReference(scene.crs?.()),
    });
    handle.setScope(plot.view.scope);
    handle.setGroundBasis(plot.view.groundBasisNote);
    handle.setStatus(plot.view.status);
    handle.setDetail(plot.view.detail);
    link = attachSectionPointLink({
      plot,
      section,
      handle,
      scene,
      unitToMetres: metres,
      devicePixelRatio: scene.devicePixelRatio(),
    });
    const observe = scene.observeCanvasSize ?? observeElementSize;
    releaseSize = observe(handle.canvas, () => {
      if (stopped) return;
      plot.draw();
      // The plot's placement just changed, so the hit index built over the
      // previous one would answer for pixels that now hold different returns.
      link?.invalidate();
    });
  }

  // The second stage: set once the corridor walk has answered, and pumped by
  // the same loop under the same budget.
  let section: ProfileSectionResult | null = null;
  let select: Generator<number, Uint32Array, void> | null = null;

  function slice(): void {
    if (stopped) return;
    const start = now();
    for (;;) {
      if (select) {
        const chosen = select.next();
        if (chosen.done) {
          finish(section!, chosen.value);
          return;
        }
      } else {
        const step = walk.next();
        if (step.done) {
          if (!step.value) {
            handle.setStatus('No layer is currently eligible for a section.');
            return;
          }
          section = step.value;
          select = selectProfileSectionLodChunks(section.points, {
            cap: MAX_DRAWN_RETURNS,
            chunkSize: SECTION_CHUNK_SIZE,
          });
        }
      }
      if (now() - start >= SLICE_BUDGET_MS) break;
    }
    schedule(slice);
  }

  slice();
  return dispose;
}

// ─────────────────────────────────────────────────────────────────────────────
// Point linkage: the section plot to the return it names in 3D
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pixel radius a hover reaches.
 *
 * Wide enough that a single return is catchable with an ordinary pointer, and
 * narrow enough that the nearest-with-deterministic-tie-break rule in
 * `queryProfileHitTest` is deciding between neighbours rather than between
 * halves of the plot.
 */
export const HIT_RADIUS_PX = 8;

/** The row the detail list carries for the state of the 3D link. */
export const LINK_ROW_LABEL = '3D link';

/** What the plot needs to link its returns to the scene. */
export interface SectionPointLinkOptions {
  readonly plot: WorkbenchSectionPlot;
  readonly section: ProfileSectionResult;
  readonly handle: {
    canvas: HTMLCanvasElement;
    overlay?: HTMLCanvasElement;
    setDetail(rows: readonly ProfileWorkbenchDetailRow[] | null): void;
    setReadout?(text: string | null): void;
  };
  readonly scene: WorkbenchSectionScene;
  /** Metres per section unit, or null when the frame cannot state one. */
  readonly unitToMetres: number | null;
  readonly devicePixelRatio: number;
}

/** A live linkage, and the means to take it down. */
export interface SectionPointLink {
  readonly controller: ProfileLinkController;
  /** Rebuild the hit-test index and repaint. Call after the plot redraws. */
  invalidate(): void;
  release(): void;
}

/** A frame if the host has one, a task otherwise. */
function schedulePointerFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
  else setTimeout(run, 0);
}

/**
 * Bind pointer input on the plot with plain DOM listeners.
 *
 * `offsetX/offsetY` is the plot's own coordinate space, which is what the hit
 * index and the draw transform are both stated in; a client coordinate would
 * need the canvas rectangle and would be wrong for one frame after any scroll
 * or dock resize that has not laid out yet.
 */
function observePointerOnCanvas(
  canvas: HTMLCanvasElement,
  handlers: WorkbenchPointerHandlers,
): () => void {
  const at = (ev: Event): { x: number; y: number } => {
    const p = ev as PointerEvent;
    return { x: p.offsetX, y: p.offsetY };
  };
  const onMove = (ev: Event): void => {
    const p = at(ev);
    handlers.move(p.x, p.y);
  };
  const onLeave = (): void => handlers.leave();
  const onClick = (ev: Event): void => {
    const p = at(ev);
    handlers.click(p.x, p.y);
  };
  // Double click, not a modifier: the camera move is the one action here that
  // changes the 3D view, so it takes a gesture nobody performs by accident
  // while reading along the section.
  const onDoubleClick = (ev: Event): void => {
    const p = at(ev);
    handlers.focus(p.x, p.y);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointercancel', onLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDoubleClick);
  return () => {
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('pointercancel', onLeave);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('dblclick', onDoubleClick);
  };
}

/** The detail rows for one locked return, with the state of its 3D link. */
function lockedDetailRows(
  detail: ReturnType<typeof buildProfilePointDetail>,
  state: ProfileReturnLocation,
): ProfileWorkbenchDetailRow[] {
  const rows: ProfileWorkbenchDetailRow[] = [];
  if (detail) {
    for (const row of detail.rows) {
      // A row the return does not carry keeps its label and says so. Dropping
      // it would make an absent channel indistinguishable from one the section
      // never had, which is the distinction the descriptor exists to hold.
      rows.push({ label: row.label, value: row.known && row.value !== null ? row.value : 'unknown' });
    }
  }
  rows.push({ label: LINK_ROW_LABEL, value: profileLinkStatusText(state) });
  return rows;
}

/**
 * Wire hover and click on the section plot to the return they name in 3D.
 *
 * Returns null when the host offers no way to resolve a return, in which case
 * the plot behaves exactly as it did before: it draws, it reports its figures,
 * and it takes no pointer input at all.
 *
 * EVERY ROUTE IS BY IDENTITY. A pointer position picks a section INDEX through
 * the screen-cell index; the index becomes a slot, a source kind, a source id
 * and that source's own point index; the scene is asked for THAT point. No
 * step of it compares coordinates, so two returns a millimetre apart in a
 * corridor are never confused for one another.
 */
export function attachSectionPointLink(
  options: SectionPointLinkOptions,
): SectionPointLink | null {
  const { plot, section, handle, scene } = options;
  const locateReturn = scene.locateReturn;
  if (!locateReturn) return null;

  const points = section.points;
  const reference = pointVerticalReference(scene.crs?.());
  const unitToMetres = options.unitToMetres ?? undefined;
  // The card reads its world coordinates through the SAME locator the marker
  // uses, so an evicted node blanks the coordinate rows instead of showing
  // where the point used to be.
  const locator = (
    identity: { kind: 'static' | 'resident'; sourceId: string; pointIndex: number },
    out: Float64Array,
  ): ProfileReturnLocation =>
    locateReturn(
      { kind: identity.kind, id: identity.sourceId, pointIndex: identity.pointIndex },
      out,
    );
  const detailSources = profileDetailSources(section.sources, locator);
  const markerSize = profileMarkerSize(section.band);

  let index: ProfileHitTestIndex | null = null;

  /** The hit index for the CURRENT drawn frame, rebuilt only when it changed. */
  function ensureIndex(): ProfileHitTestIndex | null {
    if (index) return index;
    const frame = plot.frame();
    if (!frame) return null;
    index = buildProfileHitTestIndex({
      section: points,
      displayed: plot.indices,
      widthPx: frame.viewport.width,
      heightPx: frame.viewport.height,
      // The affine restated from `profileDataToScreen`: same origin, same
      // scales, same sign flip on height. The two cannot drift because the
      // view they read is the one the draw recorded.
      projection: {
        chainageAtOrigin: frame.view.centreChainage,
        heightAtOrigin: frame.view.centreHeight,
        originXPx: frame.viewport.width / 2,
        originYPx: frame.viewport.height / 2,
        pxPerChainage: frame.view.pxPerChainage,
        pxPerHeight: frame.view.pxPerHeight,
      },
      cellSizePx: HIT_RADIUS_PX * 2,
    });
    return index;
  }

  function paint(
    hover: { x: number; y: number } | null,
    locked: { x: number; y: number } | null,
  ): void {
    const overlay = handle.overlay;
    if (!overlay) return;
    const ctx = overlay.getContext('2d') as ProfileLinkOverlayContext | null;
    if (!ctx) return;
    const width = overlay.clientWidth;
    const height = overlay.clientHeight;
    if (!(width > 0) || !(height > 0)) return;
    const dpr = options.devicePixelRatio > 0 ? options.devicePixelRatio : 1;
    const deviceWidth = Math.max(1, Math.round(width * dpr));
    const deviceHeight = Math.max(1, Math.round(height * dpr));
    // Assigning either dimension clears the surface, so it is written only on
    // a real change; the draw below clears it anyway.
    if (overlay.width !== deviceWidth) overlay.width = deviceWidth;
    if (overlay.height !== deviceHeight) overlay.height = deviceHeight;
    drawProfileLinkOverlay(ctx, {
      widthPx: width,
      heightPx: height,
      devicePixelRatio: dpr,
      hover,
      locked,
    });
  }

  const controller = createProfileLinkController({
    query: (x, y) => {
      const live = ensureIndex();
      return live ? queryProfileHitTest(live, x, y, HIT_RADIUS_PX) : null;
    },
    project: (i, out) => {
      const frame = plot.frame();
      if (!frame || i < 0 || i >= points.count) return false;
      profileDataToScreen(frame.view, frame.viewport, points.chainage[i]!, points.height[i]!, out);
      return Number.isFinite(out[0]!) && Number.isFinite(out[1]!);
    },
    identify: (i) => profileReturnIdentity(points, section.sources, i),
    locate: (identity, out) => locator(identity, out),
    readout: (i) =>
      profileHoverReadout(points, i, { reference, unitToMetres }),
    detail: (i) =>
      buildProfilePointDetail(points, i, {
        sources: detailSources,
        crs: scene.crs?.(),
        ...(unitToMetres === undefined ? {} : { unitToMetres }),
      }),
    schedule: scene.schedulePointerFlush ?? schedulePointerFrame,
    paint,
    mark: (marker) => {
      scene.markLinkedReturn?.(marker ? { ...marker, size: markerSize } : null);
    },
    present: (state) => {
      // The hover line, then the locked one: a pointer that has left the plot
      // leaves the selection's own line standing rather than an empty strip.
      handle.setReadout?.(state.hover?.readout ?? state.locked?.readout ?? null);
      // With nothing selected the list returns to the section's own figures,
      // which is what the panel showed before anything was clicked.
      handle.setDetail(
        state.locked ? lockedDetailRows(state.detail, state.locked.state) : plot.view.detail,
      );
    },
    ...(scene.focusPoint ? { focus: scene.focusPoint } : {}),
  });

  const observe = scene.observePointer ?? observePointerOnCanvas;
  const release = observe(handle.canvas, {
    move: (x, y) => controller.pointerMove(x, y),
    leave: () => controller.pointerLeave(),
    click: (x, y) => controller.click(x, y),
    focus: (x, y) => {
      controller.click(x, y);
      controller.focusSelection();
    },
  });

  return {
    controller,
    invalidate: () => {
      index = null;
      controller.refresh();
    },
    release: () => {
      release();
      controller.dispose();
    },
  };
}
