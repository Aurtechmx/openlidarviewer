/**
 * InspectTool.ts
 *
 * Point inspection. With the tool active the user clicks a point on the scan;
 * the tool drops a glowing marker on it and shows a compact floating card with
 * the point's coordinates and attributes, plus a one-click Copy button.
 *
 * Like MeasureTool, the marker is an **SVG overlay** projected from 3D each
 * frame rather than a scene object — this sidesteps the WebGPU one-pixel point
 * limit and keeps the marker crisp at any depth. The picked-point data shape
 * and its serialisations live in the pure, unit-tested `pointInfo.ts`.
 *
 * Browser-bound (DOM + three.js camera) — not imported in Node tests.
 */

import * as THREE from 'three/webgpu';
import { el } from '../ui/dom';
import {
  type PointInfo,
  classificationText,
  intensityText,
  rgbText,
  returnText,
  pointSourceIdText,
  gpsTimeText,
  normalText,
  pointInfoCopyText,
} from './pointInfo';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { utmConverter } from '../geo/UtmConverter';

/**
 * The pieces of cloud / CRS context the inspector needs to compute
 * world and geographic coordinates from the local point position.
 *
 *   - `origin` is the world-space shift the loader applied to recentre
 *     positions (Float32 precision savings). World coord = local + origin.
 *   - `crs` is the resolved CRS for the active scan. Drives whether
 *     lat / lon rows appear and which converter handles them.
 *
 * Both are `undefined` until a scan loads.
 */
export interface CoordinateContext {
  readonly origin?: readonly [number, number, number];
  readonly crs?: ResolvedCrs;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Touch devices have no mouse — the instructions say "Tap" rather than
 * "Click", and point at the on-screen Done button instead of the Esc key.
 */
const COARSE_POINTER =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;
const PICK_VERB = COARSE_POINTER ? 'Tap' : 'Click';
const FINISH_HINT = COARSE_POINTER ? 'tap Done to finish' : 'Esc to finish';

/** Hooks the tool calls back into. */
export interface InspectCallbacks {
  /** The user dismissed the tool (the "Done" button). */
  onExit: () => void;
}

/** Create an SVG element with attributes set. */
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** One label/value line in the info card. */
function infoRow(label: string, value: string, title?: string): HTMLElement {
  return el('div', { className: 'olv-inspect-row' }, [
    el('span', { className: 'olv-inspect-row-label', text: label }),
    el('span', { className: 'olv-inspect-row-value', text: value, title }),
  ]);
}

/**
 * A small uppercase header that visually groups the rows beneath it.
 * Used by the inspector card to separate Local / World / Geographic /
 * Attributes sections so the user reads four distinct intents instead
 * of a single long list.
 */
function coordGroupHeader(text: string): HTMLElement {
  return el('div', { className: 'olv-inspect-group', text });
}

/**
 * WGS84 lat/lon — the target CRS for the geographic conversion the
 * inspector card surfaces. EPSG:4326. Kept as a local constant so the
 * card doesn't have to import the registry helpers.
 */
const WGS84_GEOGRAPHIC: ResolvedCrs = {
  kind: 'geographic',
  name: 'WGS 84',
  epsg: 4326,
  linearUnit: 'unknown',
  linearUnitToMetres: 1,
  source: 'default-assumption',
  confidence: 'high',
  userConfirmed: false,
};

/**
 * Labels for the World coordinate group — Eastings/Northings when the
 * dataset is projected (UTM, state plane), Lat/Lon when it's geographic.
 * Drives only the row labels; the values come from `worldX/Y/Z` either way.
 */
function labelsForCrs(crs: ResolvedCrs | undefined): {
  readonly heading: string;
  readonly x: string;
  readonly y: string;
  readonly z: string;
} {
  if (!crs || crs.kind === 'local' || crs.kind === 'unknown') {
    return { heading: 'World', x: 'X', y: 'Y', z: 'Z' };
  }
  if (crs.kind === 'geographic') {
    return { heading: 'World (geographic)', x: 'Longitude', y: 'Latitude', z: 'Elevation' };
  }
  return {
    heading: `World (${crs.name})`,
    x: 'Easting',
    y: 'Northing',
    z: 'Elevation',
  };
}

/**
 * Copy text to the clipboard. Uses the async Clipboard API, falling back to a
 * hidden-textarea `execCommand` for older or non-secure contexts.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export class InspectTool {
  /** SVG layer drawing the selected-point marker — append to the overlay. */
  readonly overlay: SVGSVGElement;
  /** The top-centre instruction bar — append to the overlay. */
  readonly hint: HTMLElement;
  /** The floating point-info card — append to the overlay. */
  readonly card: HTMLElement;

  private readonly _camera: THREE.PerspectiveCamera;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _cb: InspectCallbacks;
  private readonly _hintText: HTMLElement;
  private readonly _cardBody: HTMLElement;
  private readonly _copyBtn: HTMLButtonElement;
  private readonly _copyNote: HTMLElement;

  private _active = false;
  /** The currently selected point, or null when nothing is picked. */
  private _selected: { info: PointInfo; world: THREE.Vector3 } | null = null;
  private _copyTimer: number | null = null;
  /** Cloud origin + CRS — drives World and Lat/Lon rows. */
  private _coordContext: CoordinateContext = {};

  private readonly _ndc = new THREE.Vector3();
  private readonly _cameraSpace = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    callbacks: InspectCallbacks,
  ) {
    this._camera = camera;
    this._canvas = canvas;
    this._cb = callbacks;

    this.overlay = document.createElementNS(SVG_NS, 'svg');
    this.overlay.setAttribute('class', 'olv-measure-svg');

    // ── Top-centre instruction bar — reuses the measure-hint styling ───────
    this._hintText = el('span', { className: 'olv-measure-hint-text' });
    const done = el('button', { className: 'olv-measure-done', text: 'Done' });
    done.addEventListener('click', () => {
      done.blur();
      this._cb.onExit();
    });
    this.hint = el('div', { className: 'olv-measure-hint olv-hidden' }, [
      el('div', { className: 'olv-measure-hint-row' }, [
        el('span', { className: 'olv-measure-badge', text: 'Inspect' }),
        this._hintText,
      ]),
      el('div', { className: 'olv-measure-actions' }, [done]),
    ]);

    // ── Floating info card ────────────────────────────────────────────────
    this._cardBody = el('div', { className: 'olv-inspect-rows' });
    this._copyNote = el('span', {
      className: 'olv-inspect-copied olv-hidden',
      text: 'Point info copied',
    });
    this._copyBtn = el('button', { className: 'olv-inspect-copy', text: 'Copy' });
    this._copyBtn.addEventListener('click', () => {
      this._copyBtn.blur();
      void this._copy();
    });
    this.card = el('div', { className: 'olv-inspect-card olv-hidden' }, [
      el('div', { className: 'olv-inspect-card-title', text: 'Point Info' }),
      this._cardBody,
      el('div', { className: 'olv-inspect-card-foot' }, [this._copyBtn, this._copyNote]),
    ]);
  }

  /** Whether inspection mode is currently on. */
  get active(): boolean {
    return this._active;
  }

  /**
   * Set the active scan's origin + CRS. Used by the inspector's card to
   * compute World (origin-relative) and Lat / Lon (CRS-projected) rows
   * in addition to the always-shown Local X/Y/Z. Called by main.ts
   * after every scan-load and every CRS override.
   */
  setCoordinateContext(ctx: CoordinateContext): void {
    this._coordContext = ctx;
    // If a point is already selected, repaint the card so the new
    // World / Lat-Lon rows appear immediately.
    if (this._selected) this._fillCard(this._selected.info);
  }

  /** Enter or leave inspection mode. */
  setActive(on: boolean): void {
    this._active = on;
    this.hint.classList.toggle('olv-hidden', !on);
    this._canvas.style.cursor = on ? 'crosshair' : '';
    if (on) {
      this._setHint(`${PICK_VERB} a point to view its data`);
    } else {
      // Leaving the tool clears the selection, marker and card.
      this._selected = null;
      this.card.classList.add('olv-hidden');
    }
    this.render();
  }

  /**
   * Show data for a picked point. Pass `null` when a click missed the cloud so
   * the tool can prompt the user; a new point replaces any previous selection.
   */
  showPoint(info: PointInfo | null, world: THREE.Vector3 | null): void {
    if (!this._active) return;
    if (!info || !world) {
      this._selected = null;
      this.card.classList.add('olv-hidden');
      this._setHint(`No point selected. ${PICK_VERB} directly on the point cloud.`);
      this.render();
      return;
    }
    this._selected = { info, world: world.clone() };
    this._fillCard(info);
    this.card.classList.remove('olv-hidden');
    this._setHint(`${PICK_VERB} another point, or ${FINISH_HINT}`);
    this.render();
  }

  /** Re-project the marker and reposition the card. Call once per frame. */
  render(): void {
    // Per-frame DOM thrash bail. Inspect mode is opt-in; until a point is
    // selected we used to write `viewBox`, call `replaceChildren()`, and
    // read `card.offsetWidth/offsetHeight` (which forces layout) every frame
    // at 60 Hz with nothing to draw. No selection → early-out; only clear
    // the overlay once on the transition.
    if (!this._selected) {
      if (this.overlay.childNodes.length > 0) {
        this.overlay.replaceChildren();
      }
      return;
    }
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    this.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const p = this._project(this._selected.world);
    if (!p.visible) {
      // The point is behind the camera — hide the marker and card.
      this.overlay.replaceChildren();
      this.card.classList.add('olv-hidden');
      return;
    }
    if (this._active) this.card.classList.remove('olv-hidden');
    // Marker: a soft halo behind a bright dot.
    this.overlay.replaceChildren(
      svg('circle', { cx: p.x, cy: p.y, r: 11, class: 'olv-inspect-halo' }),
      svg('circle', { cx: p.x, cy: p.y, r: 4, class: 'olv-inspect-dot' }),
    );
    this._positionCard(p.x, p.y, w, h);
  }

  /**
   * Visual Export Studio — serialise the marker SVG so the snapshot
   * pipeline can composite it onto the exported PNG, mirroring how
   * `MeasureController.overlaySVG()` and `AnnotateController.markerSVG()`
   * already feed into the same path. Returns an empty SVG with the correct
   * viewBox when no point is selected, so the call site doesn't need to
   * special-case "nothing to draw" — the empty SVG layers cleanly.
   */
  overlaySVG(): string {
    return new XMLSerializer().serializeToString(this.overlay);
  }

  /**
   * Visual Export Studio — the selected point + its projected
   * screen position, or `null` when no point is picked. The Studio export
   * pipeline uses this to draw the point-info card onto the export canvas
   * (the live `card` is HTML, not directly compositable into a 2-D canvas,
   * so it gets rebuilt as a canvas-drawn card during compose). Returns the
   * info in render coordinates so the export can place the card without
   * having to re-project the world position itself.
   */
  selectionForExport(): { info: PointInfo; screen: { x: number; y: number } } | null {
    if (!this._selected) return null;
    const p = this._project(this._selected.world);
    if (!p.visible) return null;
    return { info: this._selected.info, screen: { x: p.x, y: p.y } };
  }

  /** Free DOM references. */
  dispose(): void {
    if (this._copyTimer !== null) clearTimeout(this._copyTimer);
    this._canvas.style.cursor = '';
    this.overlay.remove();
    this.hint.remove();
    this.card.remove();
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private _setHint(text: string): void {
    this._hintText.textContent = text;
  }

  /** Populate the card rows from a point's data. */
  private _fillCard(info: PointInfo): void {
    const rows: HTMLElement[] = [];

    // ── Local coordinates — always shown (the renderer's frame) ─────────────
    rows.push(coordGroupHeader('Local'));
    rows.push(infoRow('X', `${info.x} m`));
    rows.push(infoRow('Y', `${info.y} m`));
    rows.push(infoRow('Z', `${info.z} m`));

    // ── World coordinates — when an origin offset exists ───────────────────
    const origin = this._coordContext.origin;
    const localX = Number.parseFloat(String(info.x));
    const localY = Number.parseFloat(String(info.y));
    const localZ = Number.parseFloat(String(info.z));
    const worldX = origin && Number.isFinite(localX) ? localX + origin[0] : undefined;
    const worldY = origin && Number.isFinite(localY) ? localY + origin[1] : undefined;
    const worldZ = origin && Number.isFinite(localZ) ? localZ + origin[2] : undefined;
    const worldLabels = labelsForCrs(this._coordContext.crs);
    if (
      typeof worldX === 'number' &&
      typeof worldY === 'number' &&
      typeof worldZ === 'number'
    ) {
      rows.push(coordGroupHeader(worldLabels.heading));
      rows.push(infoRow(worldLabels.x, `${worldX.toFixed(3)} m`));
      rows.push(infoRow(worldLabels.y, `${worldY.toFixed(3)} m`));
      rows.push(infoRow(worldLabels.z, `${worldZ.toFixed(3)} m`));
    }

    // ── Geographic coordinates — when CRS supports projection to WGS84 ────
    const crs = this._coordContext.crs;
    if (
      crs &&
      typeof worldX === 'number' &&
      typeof worldY === 'number' &&
      typeof worldZ === 'number' &&
      utmConverter.canConvert(crs, WGS84_GEOGRAPHIC) === true
    ) {
      const geo = utmConverter.toGeographic(
        { x: worldX, y: worldY, z: worldZ },
        crs,
      );
      if (geo.ok) {
        rows.push(coordGroupHeader('Geographic (WGS 84)'));
        rows.push(infoRow('Latitude', `${geo.value.lat.toFixed(7)}°`));
        rows.push(infoRow('Longitude', `${geo.value.lon.toFixed(7)}°`));
        if (typeof geo.value.elevation === 'number') {
          rows.push(infoRow('Elevation', `${geo.value.elevation.toFixed(3)} m`));
        }
      }
    }

    // ── Existing attribute rows ────────────────────────────────────────────
    rows.push(coordGroupHeader('Attributes'));
    rows.push(infoRow('Distance', `${info.distance} m`));
    rows.push(infoRow('Intensity', intensityText(info)));
    rows.push(infoRow('Classification', classificationText(info)));
    rows.push(infoRow('RGB', rgbText(info)));
    // The LAS inspection extras get a row only when the cloud carries them —
    // a non-LAS scan shows no empty "Not available" clutter.
    const ret = returnText(info);
    if (ret) rows.push(infoRow('Return', ret));
    const source = pointSourceIdText(info);
    if (source) rows.push(infoRow('Point source', source));
    const gps = gpsTimeText(info);
    if (gps) rows.push(infoRow('GPS time', gps, gps));
    const normal = normalText(info);
    if (normal) rows.push(infoRow('Normal', normal, normal));
    rows.push(infoRow('Layer', info.layer, info.layer));
    rows.push(infoRow('Index', info.index.toLocaleString('en-US')));
    // Refining-hint — "still refining" hint. Only present on streaming picks that
    // landed on a node coarser than the deepest currently-resident one.
    if (info.streamingRefining) {
      rows.push(
        infoRow(
          'Detail',
          'still refining',
          'A finer-detail version of this region is still loading.',
        ),
      );
    }
    this._cardBody.replaceChildren(...rows);
    this._copyNote.classList.add('olv-hidden');
    this._copyBtn.textContent = 'Copy';
  }

  /** Copy the selected point's data to the clipboard, then confirm briefly. */
  private async _copy(): Promise<void> {
    if (!this._selected) return;
    const ok = await copyToClipboard(pointInfoCopyText(this._selected.info));
    if (!ok) return;
    this._copyNote.classList.remove('olv-hidden');
    if (this._copyTimer !== null) clearTimeout(this._copyTimer);
    this._copyTimer = window.setTimeout(() => {
      this._copyNote.classList.add('olv-hidden');
      this._copyTimer = null;
    }, 1800);
  }

  /** Project a world point to canvas pixels, flagging if it is in front. */
  private _project(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    this._cameraSpace.copy(p).applyMatrix4(this._camera.matrixWorldInverse);
    const inFront = this._cameraSpace.z < 0; // the camera looks down -Z
    this._ndc.copy(p).project(this._camera);
    return {
      x: (this._ndc.x * 0.5 + 0.5) * this._canvas.clientWidth,
      y: (-this._ndc.y * 0.5 + 0.5) * this._canvas.clientHeight,
      visible: inFront,
    };
  }

  /** Place the card beside the marker, flipping and clamping to stay in view. */
  private _positionCard(px: number, py: number, w: number, h: number): void {
    const cw = this.card.offsetWidth || 210;
    const ch = this.card.offsetHeight || 220;
    let left = px + 20;
    if (left + cw > w - 12) left = px - 20 - cw; // flip to the marker's left
    left = Math.max(12, Math.min(left, w - cw - 12));
    const top = Math.max(12, Math.min(py - ch / 2, h - ch - 12));
    this.card.style.left = `${left}px`;
    this.card.style.top = `${top}px`;
  }
}
