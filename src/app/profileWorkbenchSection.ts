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
  type ProfileViewport,
} from '../render/measure/profileViewTransform';
import {
  ProfileSectionRenderer,
  type ProfileRenderingContext,
  type ProfileSurface,
} from '../render/measure/profileSectionRenderer';
import { axisSpanCaption } from '../render/measure/profileAxes';
import {
  selectProfileSectionLod,
  selectProfileSectionLodChunks,
} from '../render/measure/profileSectionLod';

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
  /** One polite line about what was drawn. */
  readonly status: string;
  /** The figures behind the plot, as text. */
  readonly detail: ProfileWorkbenchDetailRow[];
  /** Returns actually drawn — fewer than `section.points.count` when capped. */
  readonly drawn: number;
}

/** A composed section, with the means to draw it again at a new size. */
export interface WorkbenchSectionPlot {
  readonly view: WorkbenchSectionView;
  /** Draw at the canvas's current box. A box with no area draws nothing. */
  draw(): void;
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

  function draw(): void {
    if (!renderer) return;
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
    view: { scope: section.scopeLabel, status, detail, drawn: indices.length },
    draw,
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
    setScope(text: string): void;
    setStatus(text: string): void;
    setDetail(rows: readonly ProfileWorkbenchDetailRow[] | null): void;
  },
  id: string,
  scene: WorkbenchSectionScene,
): () => void {
  let stopped = false;
  let releaseSize: (() => void) | null = null;
  // The seam reads this on every chunk boundary, so abandoning the walk costs
  // one more chunk rather than the rest of the scene.
  const signal = { aborted: false };

  function dispose(): void {
    stopped = true;
    signal.aborted = true;
    releaseSize?.();
    releaseSize = null;
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
    });
    handle.setScope(plot.view.scope);
    handle.setStatus(plot.view.status);
    handle.setDetail(plot.view.detail);
    const observe = scene.observeCanvasSize ?? observeElementSize;
    releaseSize = observe(handle.canvas, () => {
      if (!stopped) plot.draw();
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
