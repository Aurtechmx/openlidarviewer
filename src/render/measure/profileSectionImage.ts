/**
 * profileSectionImage.ts
 *
 * Compose one profile cross-section into a PNG-ready raster: the plot, the
 * axes that scale it, the legend for anything derived drawn over it, the
 * scope the returns were read under, the section's name, and how much of the
 * section the plot actually shows.
 *
 * WHY THE COUNTS ARE THE POINT
 *
 *   A section corridor can accept millions of returns while the view holds a
 *   fixed display budget, so what a reader sees is usually a sample chosen by
 *   `profileSectionLod.ts` rather than the section itself. An image that draws
 *   120,000 of 400,000 accepted returns and captions itself "400,000 returns"
 *   is not a picture of the section: the reader takes the visible density for
 *   the measured density, reads a canopy as sparser than it is, and reads a
 *   gap in the sample as a gap in the ground. Both numbers travel together on
 *   the face of the image, and the drawn number is COUNTED FROM THE DRAW, not
 *   taken from the caller's index list: a splat the renderer skipped (an index
 *   past the section, a non-finite height, a point outside the fitted plot) was
 *   never drawn and is never counted as drawn.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 *   The hover tooltip. A tooltip is a transient answer to where a pointer
 *   happened to rest at export time; rasterised into a deliverable it becomes
 *   a permanent annotation nobody chose. {@link ProfileSectionImageRequest}
 *   accepts `hoverLabel` so a caller can hand the live view's state straight
 *   in without filtering it, and this module never draws it. A selected-point
 *   annotation is drawn only when the caller passes `annotation`.
 *
 * WHAT IS REUSED RATHER THAN REBUILT
 *
 *   The plot itself is drawn by {@link ProfileSectionRenderer} through an
 *   offsetting proxy, so the exported pixels come off the same splat loop,
 *   the same colour handling and the same gap-aware station overlay as the
 *   live view, in the same order (observed returns first, derived series
 *   after). `fitProfileView` resolves the view, `profileAxes` places every
 *   tick and writes every axis title, and `describeSectionScope` writes the
 *   scope line. Nothing here re-derives a number another module owns.
 *
 * DETERMINISM
 *
 *   No `Date`, no `Math.random`, no locale-dependent formatting, no text
 *   measurement. The timestamp is a caller-supplied string. Two composes of
 *   one section with one request produce the same operations in the same
 *   order, which is what makes a byte-identical export possible.
 *
 * No DOM. The rendering context is a parameter, so a real
 * `CanvasRenderingContext2D` satisfies it and a recording double can be
 * substituted in a Node test.
 */

import {
  ProfileSectionRenderer,
  type ProfileRenderingContext,
  type ProfileSectionScene,
  type ProfileSectionStyle,
  type ProfileSurface,
} from './profileSectionRenderer';
import {
  fitProfileView,
  profileDataToScreen,
  viewExaggeration,
  type ProfileDataBounds,
  type ProfileScaleMode,
  type ProfileView,
  type ProfileViewport,
} from './profileViewTransform';
import { profileAxes, type ProfileAxesConfig, type ProfileAxesModel } from './profileAxes';
import { describeSectionScope, type ProfileSectionScope } from './profileSectionSnapshot';

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The drawing operations composition needs on top of the plot renderer's.
 *
 * Text, a saved state, and a clip. `save`/`rect`/`clip`/`restore` exist so the
 * plot pass cannot paint outside the plot rectangle and over a caption; a real
 * `CanvasRenderingContext2D` supplies all of them.
 *
 * `measureText` is deliberately absent. Layout that depends on measured text
 * depends on the host's font stack, and an export whose caption block moves
 * between machines is not reproducible.
 */
export interface ProfileImageContext extends ProfileRenderingContext {
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
}

/** The raster being composed onto. `setBackingSize` takes DEVICE pixels. */
export interface ProfileImageSurface {
  readonly ctx: ProfileImageContext;
  setBackingSize(deviceWidth: number, deviceHeight: number): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request and result
// ─────────────────────────────────────────────────────────────────────────────

/** A rectangle in CSS pixels from the top left of the image. */
export interface ProfileImageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The legend for whatever derived series is drawn over the returns.
 *
 * Structural on purpose: `profileDerivedLegend`'s `DerivedSurfaceLegend`
 * satisfies it as it stands, and so does any other overlay's legend, so this
 * module composes legend text without owning a word of it.
 */
export interface ProfileOverlayLegendText {
  /** One-line summary for the legend swatch. */
  readonly caption: string;
  /** The full statement, one line each. */
  readonly lines: readonly string[];
}

/** A selected point the caller asked to be marked. Never a hover state. */
export interface ProfileSectionImageAnnotation {
  /** Index into `scene.points`. Out of range annotates nothing. */
  readonly index: number;
  readonly label: string;
}

/** Ink. Every colour is a CSS string the caller owns. */
export interface ProfileImageTheme {
  readonly pageBackground: string;
  readonly plotBackground: string;
  readonly axis: string;
  readonly text: string;
  readonly mutedText: string;
  readonly annotation: string;
}

/** The default ink: a light sheet meant for a report page. */
export const DEFAULT_PROFILE_IMAGE_THEME: ProfileImageTheme = {
  pageBackground: 'rgb(255, 255, 255)',
  plotBackground: 'rgb(250, 250, 250)',
  axis: 'rgb(90, 90, 96)',
  text: 'rgb(20, 20, 24)',
  mutedText: 'rgb(80, 80, 88)',
  annotation: 'rgb(190, 60, 30)',
};

/** Everything one image is composed from. */
export interface ProfileSectionImageRequest {
  readonly surface: ProfileImageSurface;
  /** Image size in CSS pixels, and the backing-store ratio. */
  readonly size: ProfileViewport;
  /** What to draw. The same scene shape the live view renders. */
  readonly scene: ProfileSectionScene;
  /** Data extent the plot is fitted to. */
  readonly bounds: ProfileDataBounds;
  readonly scaleMode: ProfileScaleMode;
  /** Ticks, tick labels and axis titles, including their units. */
  readonly axes: ProfileAxesConfig;
  readonly style: ProfileSectionStyle;
  readonly theme?: ProfileImageTheme;
  /** The section's name, printed as the image's title. */
  readonly name: string;
  readonly scope: ProfileSectionScope;
  /** Whether the streaming sources were fully resident; null when unknown. */
  readonly streamingComplete: boolean | null;
  /**
   * Returns the section ACCEPTED, which is the record the plot samples from.
   * Negative or non-finite reads as "not recorded" and the caption says so
   * rather than implying the drawn count was the whole of it.
   */
  readonly acceptedCount: number;
  /** Legend for the derived series, when one is drawn. */
  readonly legend?: ProfileOverlayLegendText | null;
  /** Marked only when present. */
  readonly annotation?: ProfileSectionImageAnnotation | null;
  /**
   * The live view's hover readout, accepted so a caller can pass its state
   * through unfiltered. NEVER drawn. See the module header.
   */
  readonly hoverLabel?: string | null;
  /** Preformatted timestamp, or null for no timestamp line. */
  readonly generatedAt: string | null;
}

/** What was composed, and what the image now claims. */
export interface ProfileSectionImageResult {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly plot: ProfileImageRect;
  readonly view: ProfileView;
  readonly axes: ProfileAxesModel;
  /** Returns the section accepted, as supplied. */
  readonly acceptedCount: number;
  /** Splats the renderer actually put on the raster. Counted, not assumed. */
  readonly drawnCount: number;
  /** Splats skipped because they fell outside the fitted plot. */
  readonly clippedCount: number;
  /** True when fewer returns were drawn than the section accepted. */
  readonly decimated: boolean;
  /** The sentence that discloses both counts. */
  readonly countsCaption: string;
  readonly scopeLine: string;
  readonly scaleCaption: string;
  /** True when the caller asked for a selected-point annotation and it landed. */
  readonly annotated: boolean;
  /** Every string drawn, in draw order. Doubles as the image's alt text. */
  readonly texts: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants, CSS pixels
// ─────────────────────────────────────────────────────────────────────────────

const PAD = 16;
const TITLE_SIZE = 18;
const BODY_SIZE = 12;
const AXIS_SIZE = 11;
const LINE_H = 15;
const TICK_LEN = 5;
/** Left margin: rotated height-axis title, then its tick labels. */
const LEFT_MARGIN = 74;
const MIN_PLOT_SIDE = 40;
const ANNOTATION_ARM = 6;

const FONT_FAMILY = 'sans-serif';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thousands-grouped integer, without `toLocaleString`.
 *
 * `toLocaleString` follows the host's default locale, so the same section
 * captions itself `400,000` on one machine and `400.000` on another and the
 * two exports differ byte for byte. The grouping is fixed here instead.
 */
function groupedInt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const digits = String(Math.max(0, Math.trunc(n)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i]!;
  }
  return out;
}

/** At most `dp` decimals, without a trailing run of zeros. */
function trimmed(value: number, dp: number): string {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(dp);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/**
 * The disclosure sentence.
 *
 * Both numbers, every time. A drawn count equal to the accepted count still
 * prints both, so the reader never has to infer from the absence of a caveat
 * that nothing was dropped.
 */
export function profileCountsCaption(drawn: number, accepted: number): string {
  const d = Number.isFinite(drawn) && drawn > 0 ? Math.trunc(drawn) : 0;
  if (!Number.isFinite(accepted) || accepted < 0) {
    return `Returns drawn: ${groupedInt(d)}; the accepted total was not recorded, so what share of the section this is cannot be stated.`;
  }
  const a = Math.trunc(accepted);
  if (a === 0 && d === 0) {
    return 'Returns drawn: 0 of 0 accepted; the section is empty.';
  }
  if (d < a) {
    const share = a > 0 ? `${((d / a) * 100).toFixed(1)} %` : '0.0 %';
    return `Returns drawn: ${groupedInt(d)} of ${groupedInt(a)} accepted (${share}); a decimated sample of the section, not every accepted return.`;
  }
  if (d > a) {
    return `Returns drawn: ${groupedInt(d)} of ${groupedInt(a)} accepted; the drawn count exceeds the accepted total supplied, so one of the two is wrong.`;
  }
  return `Returns drawn: ${groupedInt(d)} of ${groupedInt(a)} accepted (100.0 %); every accepted return is drawn.`;
}

/** The scale sentence, stating the exaggeration that was achieved. */
function scaleCaption(
  requested: ProfileScaleMode,
  fellBackToFit: boolean,
  achieved: number | null,
): string {
  if (fellBackToFit) {
    return 'Scale: fitted to the extent; a vertical exaggeration cannot be stated for these units.';
  }
  if (requested.kind === 've' && achieved != null) {
    return `Scale: vertical exaggeration ${trimmed(achieved, 2)}:1.`;
  }
  if (achieved != null) {
    return `Scale: fitted to the extent; the vertical exaggeration that produces is ${trimmed(achieved, 2)}:1.`;
  }
  return 'Scale: fitted to the extent; no vertical exaggeration is stated.';
}

// ─────────────────────────────────────────────────────────────────────────────
// The plot pass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Presents the image context to {@link ProfileSectionRenderer} as if the plot
 * rectangle were a canvas of its own.
 *
 * Three adaptations, each with a reason.
 *
 *   `setTransform` gains the plot origin, so the renderer keeps working in its
 *   own 0,0 to width,height frame and its transform, its DPR handling and the
 *   splat geometry stay exactly what the live view uses.
 *
 *   `clearRect` becomes a fill of the plot background. There is nothing to
 *   clear on a fresh export raster, and clearing would punch the page
 *   background out from under the section. The fill goes to the base context
 *   directly, so it is not mistaken for a splat.
 *
 *   `fillRect` counts. A splat is counted when any part of it lands inside the
 *   plot, and dropped when none of it does. That is the criterion the raster
 *   itself applies, so the drawn figure in the caption counts what a reader can
 *   see rather than restating the caller's index list. A return the fit puts
 *   exactly on the boundary has landed.
 */
class PlotProxyContext implements ProfileRenderingContext {
  private readonly base: ProfileImageContext;
  private readonly rect: ProfileImageRect;
  private readonly dpr: number;
  private readonly background: string;

  /** Splats put on the raster. */
  splats = 0;
  /** Splats dropped for falling outside the plot. */
  clipped = 0;

  constructor(
    base: ProfileImageContext,
    rect: ProfileImageRect,
    dpr: number,
    background: string,
  ) {
    this.base = base;
    this.rect = rect;
    this.dpr = dpr;
    this.background = background;
  }

  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this.base.fillStyle;
  }
  set fillStyle(v: string | CanvasGradient | CanvasPattern) {
    this.base.fillStyle = v;
  }
  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this.base.strokeStyle;
  }
  set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
    this.base.strokeStyle = v;
  }
  get lineWidth(): number {
    return this.base.lineWidth;
  }
  set lineWidth(v: number) {
    this.base.lineWidth = v;
  }
  get globalAlpha(): number {
    return this.base.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.base.globalAlpha = v;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.base.setTransform(a, b, c, d, e + this.rect.x * this.dpr, f + this.rect.y * this.dpr);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const previous = this.base.fillStyle;
    this.base.fillStyle = this.background;
    this.base.fillRect(x, y, w, h);
    this.base.fillStyle = previous;
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (x + w < 0 || y + h < 0 || x > this.rect.width || y > this.rect.height) {
      this.clipped++;
      return;
    }
    this.splats++;
    this.base.fillRect(x, y, w, h);
  }

  beginPath(): void {
    this.base.beginPath();
  }
  moveTo(x: number, y: number): void {
    this.base.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.base.lineTo(x, y);
  }
  stroke(): void {
    this.base.stroke();
  }
}

/** The surface handed to the renderer for the plot pass. */
class PlotProxySurface implements ProfileSurface {
  readonly ctx: PlotProxyContext;
  constructor(ctx: PlotProxyContext) {
    this.ctx = ctx;
  }
  /**
   * Ignored. The export raster is sized once by the composer; letting the
   * renderer resize it here would clear everything already composed.
   */
  setBackingSize(): void {
    /* the composer owns the backing store */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composition
// ─────────────────────────────────────────────────────────────────────────────

function positive(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** A small text writer that also records what it wrote. */
class TextInk {
  private readonly ctx: ProfileImageContext;
  readonly texts: string[] = [];

  constructor(ctx: ProfileImageContext) {
    this.ctx = ctx;
  }

  write(
    text: string,
    x: number,
    y: number,
    size: number,
    colour: string,
    align: CanvasTextAlign,
    baseline: CanvasTextBaseline,
  ): void {
    this.ctx.font = `${size}px ${FONT_FAMILY}`;
    this.ctx.fillStyle = colour;
    this.ctx.textAlign = align;
    this.ctx.textBaseline = baseline;
    this.ctx.fillText(text, x, y);
    this.texts.push(text);
  }
}

/**
 * Compose one section image.
 *
 * Order: the page ground, then the plot (observed returns, then the derived
 * series over them), then the axes in the margins, then the header and the
 * caption block, then the annotation if one was asked for. Nothing that is not
 * evidence is drawn before the evidence, and no rule crosses the plot: ticks
 * live in the margins, so no derived furniture sits over a return.
 *
 * Returns what the image now claims, including the two counts, so a caller can
 * carry the same disclosure into a manifest or an alt text without rewording
 * it.
 */
export function composeProfileSectionImage(
  request: ProfileSectionImageRequest,
): ProfileSectionImageResult {
  const theme = request.theme ?? DEFAULT_PROFILE_IMAGE_THEME;
  const ctx = request.surface.ctx;
  const ink = new TextInk(ctx);

  const widthPx = positive(request.size.width, 1);
  const heightPx = positive(request.size.height, 1);
  const dpr = positive(request.size.devicePixelRatio, 1);
  const deviceWidth = Math.max(1, Math.round(widthPx * dpr));
  const deviceHeight = Math.max(1, Math.round(heightPx * dpr));

  // ── Layout ────────────────────────────────────────────────────────────────
  const legendLines = request.legend
    ? 1 + request.legend.lines.length
    : request.scene.stations != null && request.scene.stations.length > 0
      ? 1
      : 0;
  const captionLines =
    legendLines + 2 + (request.generatedAt != null ? 1 : 0) + (request.annotation ? 1 : 0);

  const headerHeight = TITLE_SIZE + 6 + BODY_SIZE + 10;
  const axisBlockHeight = TICK_LEN + 4 + AXIS_SIZE + 6 + AXIS_SIZE + 8;
  const captionHeight = captionLines * LINE_H + PAD;

  const plotX = LEFT_MARGIN;
  const plotY = PAD + headerHeight;
  const plotWidth = Math.max(MIN_PLOT_SIDE, widthPx - plotX - PAD);
  const plotHeight = Math.max(
    MIN_PLOT_SIDE,
    heightPx - plotY - axisBlockHeight - captionHeight,
  );
  const plot: ProfileImageRect = { x: plotX, y: plotY, width: plotWidth, height: plotHeight };
  const plotViewport: ProfileViewport = {
    width: plotWidth,
    height: plotHeight,
    devicePixelRatio: dpr,
  };

  // ── View ──────────────────────────────────────────────────────────────────
  // A requested exaggeration the units cannot support is not silently drawn as
  // a fit and captioned as an exaggeration; the fallback is disclosed.
  const requested = request.scaleMode;
  let view = fitProfileView(request.bounds, plotViewport, requested, request.axes.units);
  const fellBackToFit = view === null;
  if (view === null) {
    view = fitProfileView(request.bounds, plotViewport, { kind: 'fit' }, request.axes.units);
  }
  const resolvedView: ProfileView = view ?? {
    centreChainage: 0,
    centreHeight: 0,
    pxPerChainage: 1,
    pxPerHeight: 1,
  };
  const achieved = viewExaggeration(resolvedView, request.axes.units);

  // ── Page ground ───────────────────────────────────────────────────────────
  request.surface.setBackingSize(deviceWidth, deviceHeight);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.pageBackground;
  ctx.fillRect(0, 0, widthPx, heightPx);

  // ── Plot ──────────────────────────────────────────────────────────────────
  // Clipped to the plot rectangle so nothing the section contains can paint
  // over a caption and be read as part of the caption block.
  const proxy = new PlotProxyContext(ctx, plot, dpr, theme.plotBackground);
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.width, plot.height);
  ctx.clip();
  const renderer = new ProfileSectionRenderer(new PlotProxySurface(proxy), () => {
    /* composition never schedules: the export draws synchronously */
  });
  renderer.setFrame({
    scene: request.scene,
    view: resolvedView,
    viewport: plotViewport,
    style: request.style,
  });
  renderer.renderNow();
  ctx.restore();

  const drawnCount = proxy.splats;
  const acceptedCount = request.acceptedCount;
  const decimated =
    Number.isFinite(acceptedCount) && acceptedCount >= 0 && drawnCount < Math.trunc(acceptedCount);

  // Back to page coordinates for everything the renderer did not draw.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;

  // ── Axes ──────────────────────────────────────────────────────────────────
  const axes = profileAxes(resolvedView, plotViewport, request.axes);
  drawAxes(ctx, ink, axes, plot, theme);

  // ── Header ────────────────────────────────────────────────────────────────
  const scopeLine = describeSectionScope(request.scope, request.streamingComplete);
  ink.write(request.name, PAD, PAD, TITLE_SIZE, theme.text, 'left', 'top');
  ink.write(
    `Source read: ${scopeLine}`,
    PAD,
    PAD + TITLE_SIZE + 6,
    BODY_SIZE,
    theme.mutedText,
    'left',
    'top',
  );

  // ── Captions ──────────────────────────────────────────────────────────────
  const countsCaption = profileCountsCaption(drawnCount, acceptedCount);
  const scale = scaleCaption(requested, fellBackToFit, achieved);
  let y = plot.y + plot.height + axisBlockHeight;

  if (request.legend) {
    ink.write(request.legend.caption, PAD, y, BODY_SIZE, theme.text, 'left', 'top');
    y += LINE_H;
    for (const line of request.legend.lines) {
      ink.write(line, PAD, y, AXIS_SIZE, theme.mutedText, 'left', 'top');
      y += LINE_H;
    }
  } else if (request.scene.stations != null && request.scene.stations.length > 0) {
    // A derived series is on the picture with nothing to explain it. Say that
    // it is derived rather than let it pass for a measured line.
    ink.write(
      'A derived station series is drawn over the returns; no legend was supplied for it.',
      PAD,
      y,
      BODY_SIZE,
      theme.text,
      'left',
      'top',
    );
    y += LINE_H;
  }

  ink.write(countsCaption, PAD, y, BODY_SIZE, theme.text, 'left', 'top');
  y += LINE_H;
  ink.write(scale, PAD, y, AXIS_SIZE, theme.mutedText, 'left', 'top');
  y += LINE_H;

  // ── Annotation, only when asked for ───────────────────────────────────────
  let annotated = false;
  const annotation = request.annotation;
  if (annotation) {
    annotated = drawAnnotation(ctx, ink, request, resolvedView, plotViewport, plot, theme, annotation, y);
    if (annotated) y += LINE_H;
  }

  if (request.generatedAt != null) {
    ink.write(`Composed ${request.generatedAt}`, PAD, y, AXIS_SIZE, theme.mutedText, 'left', 'top');
  }

  return {
    widthPx,
    heightPx,
    deviceWidth,
    deviceHeight,
    plot,
    view: resolvedView,
    axes,
    acceptedCount,
    drawnCount,
    clippedCount: proxy.clipped,
    decimated,
    countsCaption,
    scopeLine,
    scaleCaption: scale,
    annotated,
    texts: ink.texts,
  };
}

/**
 * Ticks, tick labels, axis titles and the plot border.
 *
 * Every rule sits OUTSIDE the plot. A grid drawn across the section would put
 * a line the data never contained on top of the returns, at the same weight as
 * the splats, which is the same mistake as an opaque derived overlay.
 */
function drawAxes(
  ctx: ProfileImageContext,
  ink: TextInk,
  axes: ProfileAxesModel,
  plot: ProfileImageRect,
  theme: ProfileImageTheme,
): void {
  ctx.strokeStyle = theme.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Border.
  ctx.moveTo(plot.x, plot.y);
  ctx.lineTo(plot.x + plot.width, plot.y);
  ctx.lineTo(plot.x + plot.width, plot.y + plot.height);
  ctx.lineTo(plot.x, plot.y + plot.height);
  ctx.lineTo(plot.x, plot.y);
  for (const px of axes.x.pixels) {
    if (!Number.isFinite(px) || px < 0 || px > plot.width) continue;
    ctx.moveTo(plot.x + px, plot.y + plot.height);
    ctx.lineTo(plot.x + px, plot.y + plot.height + TICK_LEN);
  }
  for (const py of axes.y.pixels) {
    if (!Number.isFinite(py) || py < 0 || py > plot.height) continue;
    ctx.moveTo(plot.x - TICK_LEN, plot.y + py);
    ctx.lineTo(plot.x, plot.y + py);
  }
  ctx.stroke();

  const labelY = plot.y + plot.height + TICK_LEN + 4;
  axes.x.labels.forEach((label, i) => {
    const px = axes.x.pixels[i];
    if (px == null || !Number.isFinite(px) || px < 0 || px > plot.width) return;
    ink.write(label, plot.x + px, labelY, AXIS_SIZE, theme.mutedText, 'center', 'top');
  });
  axes.y.labels.forEach((label, i) => {
    const py = axes.y.pixels[i];
    if (py == null || !Number.isFinite(py) || py < 0 || py > plot.height) return;
    ink.write(label, plot.x - TICK_LEN - 4, plot.y + py, AXIS_SIZE, theme.mutedText, 'right', 'middle');
  });

  // Titles carry the unit; the tick labels are bare numbers, which is the
  // split `profileAxes` defines.
  ink.write(
    axes.x.title,
    plot.x + plot.width / 2,
    labelY + AXIS_SIZE + 6,
    AXIS_SIZE,
    theme.text,
    'center',
    'top',
  );
  ctx.save();
  ctx.translate(PAD + AXIS_SIZE, plot.y + plot.height / 2);
  ctx.rotate(-Math.PI / 2);
  ink.write(axes.y.title, 0, 0, AXIS_SIZE, theme.text, 'center', 'middle');
  ctx.restore();
}

/**
 * Mark one selected point and print its label.
 *
 * Only ever reached when the caller passed an annotation. An index outside the
 * section, or a point whose crosshair would fall entirely off the plot, marks
 * nothing and prints nothing rather than placing a crosshair at the edge and
 * letting it stand for a position outside the view.
 */
function drawAnnotation(
  ctx: ProfileImageContext,
  ink: TextInk,
  request: ProfileSectionImageRequest,
  view: ProfileView,
  plotViewport: ProfileViewport,
  plot: ProfileImageRect,
  theme: ProfileImageTheme,
  annotation: ProfileSectionImageAnnotation,
  captionY: number,
): boolean {
  const points = request.scene.points;
  const i = annotation.index;
  if (!Number.isInteger(i) || i < 0 || i >= points.count) return false;
  const chainage = points.chainage[i];
  const height = points.height[i];
  if (chainage == null || height == null) return false;

  const out = new Float64Array(2);
  profileDataToScreen(view, plotViewport, chainage, height, out);
  const sx = out[0]!;
  const sy = out[1]!;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
  if (
    sx + ANNOTATION_ARM < 0 ||
    sy + ANNOTATION_ARM < 0 ||
    sx - ANNOTATION_ARM > plot.width ||
    sy - ANNOTATION_ARM > plot.height
  ) {
    return false;
  }

  const cx = plot.x + sx;
  const cy = plot.y + sy;
  ctx.strokeStyle = theme.annotation;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 1;
  // Clipped like the plot pass: a crosshair on the edge of the extent may not
  // spill an arm into the caption block below it.
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.width, plot.height);
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(cx - ANNOTATION_ARM, cy);
  ctx.lineTo(cx + ANNOTATION_ARM, cy);
  ctx.moveTo(cx, cy - ANNOTATION_ARM);
  ctx.lineTo(cx, cy + ANNOTATION_ARM);
  ctx.stroke();
  ctx.restore();

  ink.write(
    `Selected return: ${annotation.label}`,
    PAD,
    captionY,
    BODY_SIZE,
    theme.annotation,
    'left',
    'top',
  );
  return true;
}
