/**
 * snapshot.ts — the frame-capture pipeline the Viewer's `snapshot()` delegates to.
 *
 * Render one frame and return it as a PNG `Blob`. With no options (or all off)
 * this returns the bare rendered cloud — the original, fast path. With an
 * overlay enabled it becomes a compositor: the rendered frame is drawn into a
 * 2-D canvas at the GL drawing-buffer resolution (high-DPI preserved), then each
 * requested overlay is projected with the export camera, serialised to a
 * self-styled SVG, rasterised and drawn on top — so markers land precisely where
 * they sit in the live view.
 *
 * The logic reads the live scene through a structural {@link SnapshotHost} — a
 * handful of accessor functions rather than the Viewer itself — so nothing here
 * imports `Viewer`, the same seam the export adapter and colour legend use.
 * `Viewer` keeps a thin method that binds its own state to the host. Part of the
 * v0.6 decomposition (see `docs/architecture/architecture-map.md`).
 */

import { loadSvgImage } from './snapshotSvg';
import { classificationText, intensityText, rgbText, type PointInfo } from './pointInfo';
import { computeScaleBar, pixelsPerMetreAt } from './scaleBar';
import { burnInColorbarLayout, type ActiveColorbar } from './activeColorbar';
import { colorbarStops, niceTicks, formatColorbarValue } from './colorbar';

export interface SnapshotOptions {
  /** Include the annotation markers. */
  annotations?: boolean;
  /** Include the measurement geometry and value labels. */
  measurements?: boolean;
  /**
   * Visual Export Studio — bake the active Inspect tool state:
   * the selected-point marker (halo + dot) and a canvas-drawn point-info
   * card (X/Y/Z, intensity, classification, RGB, etc.). When false (the
   * default) the export is clean of inspector overlays even while the
   * inspect tool is active in the UI.
   */
  inspector?: boolean;
  /**
   * Visual Export Studio — bake the most recent LiveProbe readout
   * when probe mode is active. Uses the probe's last-known cursor position
   * so the bake survives the "cursor moves to click Export" gap that would
   * otherwise dismiss the live element before capture.
   */
  probe?: boolean;
  /**
   * v0.3.7 final-polish — supersample factor. 1 = native (default), 2 = 2×
   * supersampled, 4 = 4× supersampled. The snapshot renders the GL canvas
   * once at the requested resolution by upscaling the output canvas and
   * compositing through the 2-D pipeline. Output dimensions become
   * `canvas.width × factor` by `canvas.height × factor`.
   *
   * NOT a true MSAA — the GL framebuffer doesn't change. This is a
   * post-render upscale that lets overlay SVGs and scale bars composite
   * at higher resolution while the cloud itself reads at native quality.
   * Use 2× for a sharp print-ready PNG; 4× for a hero shot.
   */
  supersample?: 1 | 2 | 4;
  /**
   * v0.3.7 final-polish — composite a scale-bar overlay at the bottom-left
   * of the snapshot. The renderer feeds the bar a sane pixel-per-metre
   * derived from the current camera, the bar picks a 1-2-5 nice step,
   * and draws a contrasting bar + label.
   */
  scaleBar?: boolean;
  /**
   * Burn the labelled colorbar for the ACTIVE continuous colour mode
   * (elevation / intensity / gpsTime / returnNumber) onto the right edge of
   * the snapshot. Self-gating: categorical modes (rgb / classification /
   * normal / density / coverage / confidence) draw nothing, so callers can
   * request it unconditionally. The values come from the SAME spec-builder
   * the on-screen legend overlay renders, so the exported figure and the live
   * view can never disagree.
   */
  colorbar?: boolean;
}

/**
 * What the snapshot pipeline needs from the live scene. Accessors are
 * functions, not snapshots, so the capture always reflects the CURRENT scene —
 * the property the previous inline method had by reading `this` per call.
 */
export interface SnapshotHost {
  /** Resolves once the Viewer's first frame is ready. */
  ready(): Promise<void>;
  /** Render one frame through the active pipeline (EDL post-process or direct). */
  renderFrame(): void;
  /** The live GL drawing-buffer canvas. */
  glCanvas(): HTMLCanvasElement;
  /** The active continuous-colour legend spec, or null for categorical modes. */
  activeColorbar(): ActiveColorbar | null;
  /** Render the measurement overlay against the live camera and serialise it. */
  measurementsOverlaySVG(): string;
  /** Render the annotation markers against the live camera and serialise them. */
  annotationsOverlaySVG(): string;
  /** Render the inspector marker against the live camera and serialise it. */
  inspectorOverlaySVG(): string;
  /** The inspector's selected point for the info-card bake, or null. */
  inspectorSelection(): { info: PointInfo; screen: { x: number; y: number } } | null;
  /** The most recent probe readout for the bake, or null. */
  probeReadout(): { info: PointInfo; client: { x: number; y: number } } | null;
  /** The live canvas bounding rect, for translating client→canvas pixels. */
  canvasRect(): { left: number; top: number; width: number; height: number };
  /**
   * Camera reference for the scale bar: the orbit-target distance (what the
   * analyst is actually looking at) and the vertical field of view in radians.
   */
  scaleBarCamera(): { distanceToTarget: number; fovYRadians: number };
}

/** The resolved option flags a single capture acts on. */
export interface SnapshotPlan {
  wantAnnotations: boolean;
  wantMeasurements: boolean;
  wantInspector: boolean;
  wantProbe: boolean;
  wantScaleBar: boolean;
  wantColorbar: boolean;
  /** Only 2 or 4 promote; anything else (incl. undefined) stays native 1. */
  supersample: 1 | 2 | 4;
}

/** Resolve the raw options into the flags the capture path branches on. */
export function resolveSnapshotPlan(options?: SnapshotOptions): SnapshotPlan {
  return {
    wantAnnotations: options?.annotations === true,
    wantMeasurements: options?.measurements === true,
    wantInspector: options?.inspector === true,
    wantProbe: options?.probe === true,
    wantScaleBar: options?.scaleBar === true,
    wantColorbar: options?.colorbar === true,
    // supersample + scale bar both promote the export to the composite path so
    // the upscaled output canvas can host overlays at the requested resolution.
    supersample:
      options?.supersample === 2 || options?.supersample === 4 ? options.supersample : 1,
  };
}

/**
 * True when the capture can return the GL canvas untouched at native
 * resolution — no overlays, no upscale, no scale bar, no colorbar. `activeBar`
 * is passed in because it is resolved from the host, not the options.
 */
export function fastPathEligible(plan: SnapshotPlan, activeBar: ActiveColorbar | null): boolean {
  return (
    !plan.wantAnnotations &&
    !plan.wantMeasurements &&
    !plan.wantInspector &&
    !plan.wantProbe &&
    !plan.wantScaleBar &&
    activeBar === null &&
    plan.supersample === 1
  );
}

/** Encode a canvas to a PNG `Blob`, rejecting if the browser returns none. */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Viewer.snapshot(): canvas.toBlob returned null'));
    }, 'image/png');
  });
}

/**
 * Render one frame and capture it as a PNG `Blob`. See the module doc for the
 * fast-path / compositor split.
 */
export async function captureSnapshot(
  host: SnapshotHost,
  options?: SnapshotOptions,
): Promise<Blob> {
  await host.ready();

  // Render-and-present helper. The export pipeline mutates `colorAttr`
  // immediately before calling snapshot — for WebGPU specifically, the
  // first `render()` queues the new color buffer upload but the canvas
  // won't carry the new frame until the browser ticks an animation
  // frame. Calling `toBlob` immediately after a single un-awaited
  // `render()` reads the *previous* frame, which is why every export
  // mode came out looking identical (whatever was on screen before the
  // swap). The fix is to render, wait for a present cycle, then render
  // and wait once more — two frames is enough to flush the buffer
  // upload, the post-processing pipeline if EDL is on, and the
  // composited presentation.
  const renderAndPresent = (): Promise<void> => {
    host.renderFrame();
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
      } else {
        // Test / Node fallback — snapshot is browser-only in practice,
        // but the type-check path goes through here without rAF.
        setTimeout(resolve, 0);
      }
    });
  };
  await renderAndPresent();
  await renderAndPresent();

  const gl = host.glCanvas();
  const plan = resolveSnapshotPlan(options);
  // Colorbar burn-in — resolved up front so a categorical mode (which
  // yields null) still takes the untouched fast path below. The spec is
  // the SAME one the live overlay renders (activeColorbar), so the
  // exported figure always matches the legend on screen.
  const activeBar = plan.wantColorbar ? host.activeColorbar() : null;

  // Fast path: no overlays + no upscale + no scale bar — return the
  // GL canvas untouched at native resolution.
  if (fastPathEligible(plan, activeBar)) {
    return canvasToBlob(gl);
  }

  // Composite path: draw the GL frame into a 2-D canvas at full
  // (optionally upscaled) resolution.
  const out = document.createElement('canvas');
  out.width = gl.width * plan.supersample;
  out.height = gl.height * plan.supersample;
  const ctx = out.getContext('2d');
  if (!ctx) return canvasToBlob(gl);
  ctx.drawImage(gl, 0, 0, out.width, out.height);

  // Re-project each overlay with the export camera, then serialise it, so
  // alignment with the rendered frame is exact. Measurements sit beneath the
  // annotation markers, matching the live stacking order; the inspector
  // marker sits on top so the picked point is always identifiable.
  const layers: string[] = [];
  if (plan.wantMeasurements) {
    layers.push(host.measurementsOverlaySVG());
  }
  if (plan.wantAnnotations) {
    layers.push(host.annotationsOverlaySVG());
  }
  if (plan.wantInspector) {
    // The marker overlay is re-rendered against the live canvas so the
    // halo + dot coords match the current camera frame.
    layers.push(host.inspectorOverlaySVG());
  }
  for (const svg of layers) {
    const img = await loadSvgImage(svg);
    if (img) ctx.drawImage(img, 0, 0, out.width, out.height);
  }
  // The point-info card the live UI shows is an HTML element, not SVG, so
  // we redraw an equivalent on the 2-D canvas next to the marker. Only the
  // selected-point fields the user actually sees are baked, so the card
  // matches the live UI line for line.
  if (plan.wantInspector) {
    const sel = host.inspectorSelection();
    if (sel) drawInspectorInfoCard(ctx, sel.info, sel.screen);
  }
  // v0.3.7 final-polish — scale bar overlay. Drawn last so it sits on
  // top of everything else but underneath the inspector / probe cards.
  if (plan.wantScaleBar) {
    // Estimate pixels-per-metre from the current camera. The reference
    // distance is the orbit-target distance — what the analyst is
    // actually looking at.
    const { distanceToTarget, fovYRadians } = host.scaleBarCamera();
    const ppm = pixelsPerMetreAt(fovYRadians, out.height, distanceToTarget);
    // Use 22 % of the canvas width as the bar's budget — leaves room
    // for the label and looks balanced in the bottom-left corner.
    const budgetPx = Math.max(80, Math.min(out.width * 0.22, 400));
    const bar = computeScaleBar(ppm, budgetPx);
    if (bar.stepPixels > 0) {
      drawScaleBar(ctx, out, bar);
    }
  }

  // Colorbar legend burn-in — right edge, vertically centred, so it can
  // never collide with the scale bar (bottom-left), the Studio's
  // scan-report card (composed bottom-right after this snapshot), or the
  // class-scope banner (top). Values and ramp come from the same
  // `activeColorbar()` spec the on-screen overlay shows.
  if (activeBar) {
    drawColorbar(ctx, out, activeBar);
  }

  // LiveProbe — same compositing pattern. The probe stores its last known
  // cursor position in CLIENT coordinates; translate to canvas-local pixels
  // via the canvas's bounding rect so the bake lands where the user saw
  // the readout.
  if (plan.wantProbe) {
    const probe = host.probeReadout();
    if (probe) {
      const rect = host.canvasRect();
      const sx = (probe.client.x - rect.left) * (out.width / rect.width);
      const sy = (probe.client.y - rect.top) * (out.height / rect.height);
      drawProbeReadoutCard(ctx, probe.info, { x: sx, y: sy });
    }
  }
  return canvasToBlob(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual Export Studio — overlay compositing onto the 2-D output canvas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draw the InspectTool's "Point Info" card directly onto a 2-D canvas next
 * to the selected-point marker. Mirrors the live HTML card so the export
 * carries the same data the user saw on-screen — X/Y/Z, distance, intensity,
 * classification, RGB, optional LAS extras.
 *
 * Layout: small translucent dark card positioned to the right of the marker
 * (or left if there isn't room on the right). Auto-sizes to its content.
 */
function drawInspectorInfoCard(
  ctx: CanvasRenderingContext2D,
  info: PointInfo,
  screen: { x: number; y: number },
): void {
  // Build the rows the live card builds (see InspectTool._fillCard).
  const rows: Array<[string, string]> = [
    ['X', `${info.x} m`],
    ['Y', `${info.y} m`],
    ['Z', `${info.z} m`],
    ['Distance', `${info.distance} m`],
    ['Intensity', intensityText(info)],
    ['Classification', classificationText(info)],
    ['RGB', rgbText(info)],
  ];
  if (info.returnNumber !== undefined && info.returnCount !== undefined) {
    rows.push(['Return', `${info.returnNumber} of ${info.returnCount}`]);
  }
  if (info.pointSourceId !== undefined) {
    rows.push(['Point source', String(info.pointSourceId)]);
  }
  rows.push(['Layer', info.layer]);
  rows.push(['Index', info.index.toLocaleString('en-US')]);

  // Measure layout — the card width is driven by the widest row.
  const PAD = 14;
  const TITLE_SIZE = 14;
  const ROW_SIZE = 12;
  const ROW_GAP = 6;
  ctx.save();
  ctx.font = `600 ${TITLE_SIZE}px system-ui, -apple-system, sans-serif`;
  const titleW = ctx.measureText('Point Info').width;
  ctx.font = `${ROW_SIZE}px system-ui, -apple-system, sans-serif`;
  let labelMax = 0;
  let valueMax = 0;
  for (const [l, v] of rows) {
    labelMax = Math.max(labelMax, ctx.measureText(l).width);
    valueMax = Math.max(valueMax, ctx.measureText(v).width);
  }
  const rowWidth = labelMax + 18 + valueMax;
  const cardW = Math.max(titleW, rowWidth) + PAD * 2;
  const cardH = PAD + TITLE_SIZE + 8 + rows.length * (ROW_SIZE + ROW_GAP) - ROW_GAP + PAD;

  // Decide placement: prefer to the right of the marker, fall back to left
  // if there isn't room on the right side of the canvas.
  const MARKER_GAP = 18;
  let x = screen.x + MARKER_GAP;
  if (x + cardW > ctx.canvas.width - 8) x = screen.x - MARKER_GAP - cardW;
  let y = screen.y - cardH / 2;
  if (y < 8) y = 8;
  if (y + cardH > ctx.canvas.height - 8) y = ctx.canvas.height - 8 - cardH;

  // Card background with hairline border and accent stripe — visual style
  // matches the scan-report card so the export reads as one consistent layer.
  ctx.fillStyle = 'rgba(10, 14, 22, 0.92)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  const r = 6;
  const rr = Math.min(r, cardW / 2, cardH / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + cardW, y, x + cardW, y + cardH, rr);
  ctx.arcTo(x + cardW, y + cardH, x, y + cardH, rr);
  ctx.arcTo(x, y + cardH, x, y, rr);
  ctx.arcTo(x, y, x + cardW, y, rr);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#4f9dff';
  ctx.fillRect(x, y, 3, cardH);

  // Title.
  let cy = y + PAD + TITLE_SIZE;
  ctx.fillStyle = '#f4f6fa';
  ctx.font = `600 ${TITLE_SIZE}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('Point Info', x + PAD, cy);

  // Rows — label left, value right.
  cy += 8;
  ctx.font = `${ROW_SIZE}px system-ui, -apple-system, sans-serif`;
  for (const [label, value] of rows) {
    cy += ROW_SIZE;
    ctx.fillStyle = '#a8b0bc';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + PAD, cy);
    ctx.fillStyle = '#f4f6fa';
    ctx.textAlign = 'right';
    ctx.fillText(value, x + cardW - PAD, cy);
    cy += ROW_GAP;
  }
  ctx.restore();
}

/**
 * Draw the LiveProbe's compact readout (coordinates + key attributes) at
 * the cursor's last-known canvas position. Visually smaller than the
 * inspector card — the live probe is a glance-readout, not a study tool.
 */
function drawProbeReadoutCard(
  ctx: CanvasRenderingContext2D,
  info: PointInfo,
  screen: { x: number; y: number },
): void {
  const coords = `${info.x}, ${info.y}, ${info.z} m`;
  const attrParts: string[] = [];
  if (info.classification !== null) attrParts.push(classificationText(info));
  if (info.intensity !== null) attrParts.push(`Intensity ${info.intensity}`);
  const attrs = attrParts.join('  ·  ');

  const PAD = 10;
  const COORD_SIZE = 12;
  const ATTR_SIZE = 11;
  const ROW_GAP = 4;

  ctx.save();
  ctx.font = `600 ${COORD_SIZE}px system-ui, -apple-system, sans-serif`;
  const coordW = ctx.measureText(coords).width;
  ctx.font = `${ATTR_SIZE}px system-ui, -apple-system, sans-serif`;
  const attrW = attrs ? ctx.measureText(attrs).width : 0;
  const cardW = Math.max(coordW, attrW) + PAD * 2;
  const cardH = PAD + COORD_SIZE + (attrs ? ROW_GAP + ATTR_SIZE : 0) + PAD;

  // Cursor-aware placement — to the right and below, flipping when the
  // card would clip the canvas edges.
  const OFFSET = 16;
  let x = screen.x + OFFSET;
  if (x + cardW > ctx.canvas.width - 8) x = screen.x - OFFSET - cardW;
  let y = screen.y + OFFSET;
  if (y + cardH > ctx.canvas.height - 8) y = screen.y - OFFSET - cardH;
  if (x < 8) x = 8;
  if (y < 8) y = 8;

  // Background — visually consistent with the inspector card but smaller
  // and slightly less opaque so the cursor remains the dominant element.
  ctx.fillStyle = 'rgba(10, 14, 22, 0.88)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  const r = 5;
  const rr = Math.min(r, cardW / 2, cardH / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + cardW, y, x + cardW, y + cardH, rr);
  ctx.arcTo(x + cardW, y + cardH, x, y + cardH, rr);
  ctx.arcTo(x, y + cardH, x, y, rr);
  ctx.arcTo(x, y, x + cardW, y, rr);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Coordinates row.
  let cy = y + PAD + COORD_SIZE;
  ctx.fillStyle = '#f4f6fa';
  ctx.font = `600 ${COORD_SIZE}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(coords, x + PAD, cy);

  // Attributes row (optional).
  if (attrs) {
    cy += ROW_GAP + ATTR_SIZE;
    ctx.fillStyle = '#a8b0bc';
    ctx.font = `${ATTR_SIZE}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(attrs, x + PAD, cy);
  }
  ctx.restore();
}

/**
 * v0.3.7 final-polish — paint a scale-bar overlay in the bottom-left
 * of the output canvas. Black bar with white tips + a white outline so
 * it stays legible against any cloud colour. Label sits above the bar.
 */
function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  out: HTMLCanvasElement,
  bar: { stepPixels: number; label: string },
): void {
  if (bar.stepPixels <= 0) return;
  // Padding scales with output height so the bar reads the same on a
  // 1× snapshot and a 4× supersampled hero shot.
  const padding = Math.max(12, Math.round(out.height * 0.022));
  const barHeight = Math.max(6, Math.round(out.height * 0.008));
  const tickHeight = barHeight * 1.6;
  const fontSize = Math.max(11, Math.round(out.height * 0.018));
  const x0 = padding;
  const y0 = out.height - padding - barHeight;
  ctx.save();
  // White stroke under the bar so it reads against dark clouds.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 - 1, y0 - tickHeight + barHeight, bar.stepPixels + 2, tickHeight + 1);
  // Black bar fill.
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(x0, y0, bar.stepPixels, barHeight);
  // White tick marks at the bar's ends.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x0, y0 - tickHeight + barHeight, 2, tickHeight);
  ctx.fillRect(x0 + bar.stepPixels - 2, y0 - tickHeight + barHeight, 2, tickHeight);
  // Label above the bar — white with a black stroke so it reads on either tone.
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  const labelY = y0 - tickHeight + barHeight - 4;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(13, 17, 23, 0.85)';
  ctx.strokeText(bar.label, x0, labelY);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(bar.label, x0, labelY);
  ctx.restore();
}

/**
 * Burn the active colour mode's labelled colorbar onto the snapshot —
 * a vertical ramp on the right edge with the field name + unit above it,
 * tick labels to its left, and the honesty note (percentile window /
 * gpsTime normalisation) beneath the bar.
 *
 * RASTERISES the same data the SVG generator serialises: the ramp segments
 * come from {@link colorbarStops} (which samples the exact per-mode painting,
 * grayscale included) and the tick values from {@link niceTicks} — so the
 * burned-in legend and the on-screen SVG can never disagree. The geometry is
 * the pure {@link burnInColorbarLayout} (unit-tested separately); this
 * function only owns the ctx calls, mirroring `drawScaleBar`'s split. Text
 * is white with a dark stroke — the same treatment as the scale bar — so it
 * reads on any cloud colour without needing a backing card.
 */
function drawColorbar(
  ctx: CanvasRenderingContext2D,
  out: HTMLCanvasElement,
  active: ActiveColorbar,
): void {
  const spec = active.spec;
  const L = burnInColorbarLayout(out.width, out.height);
  const range = spec.max - spec.min;
  if (!(range > 0)) return; // defensive — the spec-builder already refuses this

  ctx.save();
  const font = (px: number, weight = 400): string =>
    `${weight} ${px}px system-ui, -apple-system, sans-serif`;
  const strokedText = (text: string, x: number, y: number): void => {
    // Dark stroke under white fill — legible on light and dark clouds alike.
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(13, 17, 23, 0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  };

  // Title (field name + unit when known) above the bar, right-aligned to the
  // bar's right edge so long labels grow inward, never off-canvas.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.font = font(L.titleFontSize, 600);
  const title = spec.unit ? `${spec.label} (${spec.unit})` : spec.label;
  const titleY = L.barY - Math.round(L.titleFontSize * 0.6);
  strokedText(title, L.barX + L.barWidth, titleY);
  // Honesty note under the bar, smaller — e.g. "p5–p95 window".
  if (active.note) {
    ctx.font = font(Math.max(9, Math.round(L.fontSize * 0.85)));
    strokedText(active.note, L.barX + L.barWidth, L.barY + L.barHeight + Math.round(L.fontSize * 1.4));
  }

  // The ramp — adjacent rects sampled from the SAME stops the SVG gradient
  // uses, bottom = min → top = max. 64 samples ≈ visually continuous while
  // staying trivially rasterisable on a bare 2D context (no gradient object,
  // so the draw also works under the mock contexts tests use).
  const stops = colorbarStops(spec.palette, 64);
  for (let i = 0; i < stops.length - 1; i++) {
    const t0 = stops[i].t;
    const t1 = stops[i + 1].t;
    const yTop = L.barY + (1 - t1) * L.barHeight;
    const h = (t1 - t0) * L.barHeight;
    const [r, g, b] = stops[i].rgb;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    // +1px overlap hides seam hairlines from fractional rects.
    ctx.fillRect(L.barX, yTop, L.barWidth, h + 1);
  }
  // White outline so the bar reads against dark clouds (scale-bar treatment).
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 1;
  ctx.strokeRect(L.barX - 0.5, L.barY - 0.5, L.barWidth + 1, L.barHeight + 1);

  // Tick labels to the LEFT of the bar (the right side is the canvas edge).
  // The exact endpoints are always labelled — the legend MUST state min/max
  // — and nice interior ticks fill in between, skipping any that would
  // collide with the endpoint labels.
  ctx.font = font(L.fontSize);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const labelX = L.barX - L.tickLength - 4;
  const yOf = (v: number): number => L.barY + (1 - (v - spec.min) / range) * L.barHeight;
  const drawTick = (v: number): void => {
    const y = yOf(v);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(L.barX - L.tickLength, Math.round(y) - 1, L.tickLength, 2);
    strokedText(formatColorbarValue(v), labelX, y);
  };
  drawTick(spec.min);
  drawTick(spec.max);
  const clearance = L.fontSize * 1.1;
  for (const v of niceTicks(spec.min, spec.max, spec.ticks ?? 5)) {
    const y = yOf(v);
    if (Math.abs(y - yOf(spec.min)) < clearance) continue;
    if (Math.abs(y - yOf(spec.max)) < clearance) continue;
    drawTick(v);
  }
  ctx.restore();
}
