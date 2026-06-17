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

import { clamp } from '../numeric';
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
  splitPointCoords,
  worldCoordLabels,
} from './pointInfo';
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import { latLonToUtm, utmConverter } from '../geo/UtmConverter';
import { buildPatchView } from './patchView';
import { colorProvenance, formatColorProvenance } from './colorProvenance';

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
 * A single label / value row inside the photometric-witness section.
 * Slightly tighter than `infoRow` so the patch + values block stays
 * compact within the inspector card's width budget.
 */
function witnessRow(label: string, value: string): HTMLElement {
  return el('div', { className: 'olv-witness-row' }, [
    el('span', { className: 'olv-witness-row-label', text: label }),
    el('span', { className: 'olv-witness-row-value', text: value }),
  ]);
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
  /**
   * Active class-filter scope stamp — e.g. `"Ground + Building · 2 of 5
   * classes"`. Empty string when the view is full / unfiltered, in which case
   * the copied text + JSON stay byte-identical to the pre-feature output.
   * main.ts pushes this in via {@link setClassScopeStamp} whenever the legend
   * filter changes, so a point copied while filtering is self-describing.
   */
  private _classScopeStamp = '';
  /** Cloud origin + CRS — drives World and Lat/Lon rows. */
  private _coordContext: CoordinateContext = {};
  /**
   * Patch-view provider — injected by the Viewer once a scan is attached.
   * Given a cloud layer + a point index inside that layer, returns the
   * raw positions + sRGB Uint8 colours so the inspector can build a
   * photometric witness for the picked point. `null` when the layer
   * does not carry per-point RGB (intensity-only, classification-only).
   *
   * Returning `null` from the function is safe — the inspector then
   * skips the witness section and renders the classic numeric card.
   */
  private _patchProvider:
    | ((layer: string, index: number) => { positions: Float32Array; colorsU8: Uint8Array } | null)
    | null = null;

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

  /**
   * Set the active class-filter scope stamp. When a class filter narrows the
   * view, the copied text and JSON payload carry this stamp so an exported /
   * pasted point is self-describing about the filter it was taken under. Pass
   * an empty string (or omit) to clear it — the no-filter copy / JSON output
   * is then byte-identical to the pre-feature shape. main.ts calls this from
   * the class-legend change handler and on scan load / close.
   */
  setClassScopeStamp(stamp: string): void {
    this._classScopeStamp = stamp;
  }

  /**
   * Wire the patch-view provider — the Viewer calls this once a scan
   * attaches. Pass `null` on scan close so the inspector falls back to
   * the classic numeric card.
   */
  setPatchProvider(
    provider:
      | ((
          layer: string,
          index: number,
        ) => { positions: Float32Array; colorsU8: Uint8Array } | null)
      | null,
  ): void {
    this._patchProvider = provider;
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

    // ── Coordinate frames ───────────────────────────────────────────────────
    // Frame convention: `makePointInfo` already added the load-time origin
    // back, so `info.x/y/z` ARE world coordinates. The local (recentred
    // render-buffer) values are `info − origin`. v0.4.3 added the origin a
    // second time here, doubling every easting/northing and feeding the
    // doubled values into the geographic projection below.
    const split = splitPointCoords(info, this._coordContext.origin);
    const worldLabels = worldCoordLabels(this._coordContext.crs);
    rows.push(coordGroupHeader(worldLabels.heading));
    // Geographic eastings/northings are degrees, not metres — use the
    // CRS-aware unit suffix so a lon/lat scan never reads "-122.4 m".
    rows.push(infoRow(worldLabels.x, `${split.world.x}${worldLabels.xUnit}`));
    rows.push(infoRow(worldLabels.y, `${split.world.y}${worldLabels.yUnit}`));
    rows.push(infoRow(worldLabels.z, `${split.world.z}${worldLabels.zUnit}`));

    // Local group — only when an origin shift exists; otherwise local ==
    // world and a second identical group would be noise.
    if (split.local) {
      rows.push(coordGroupHeader('Local'));
      rows.push(infoRow('X', `${split.local.x.toFixed(3)} m`));
      rows.push(infoRow('Y', `${split.local.y.toFixed(3)} m`));
      rows.push(infoRow('Z', `${split.local.z.toFixed(3)} m`));
    }

    // ── Geographic coordinates — when CRS supports projection to WGS84 ────
    // ── UTM grid — derived from the geographic position regardless of
    //              the source CRS, so an analyst always has a UTM
    //              reading on hand for tie-ins to other surveys.
    const crs = this._coordContext.crs;
    let lat: number | undefined;
    let lon: number | undefined;
    let elev: number | undefined;
    if (crs && utmConverter.canConvert(crs, WGS84_GEOGRAPHIC) === true) {
      // Source is a projected UTM zone — convert the WORLD position
      // (info.x/y/z, already origin-restored) to WGS-84 lat/lon for the
      // Geographic row, then derive a fresh UTM zone from that lat/lon
      // for the UTM row (it'll match the source zone).
      const geo = utmConverter.toGeographic(
        { x: split.world.x, y: split.world.y, z: split.world.z },
        crs,
      );
      if (geo.ok) {
        lat = geo.value.lat;
        lon = geo.value.lon;
        elev = geo.value.elevation;
      }
    } else if (crs && crs.kind === 'geographic') {
      // Source is already geographic — World row carried lon/lat
      // directly; reuse them for the UTM derivation.
      lat = split.world.y;
      lon = split.world.x;
      elev = split.world.z;
    }

    if (typeof lat === 'number' && typeof lon === 'number') {
      // Geographic group — render unless the World group already
      // carried it (i.e. the source CRS is geographic, in which case
      // the World row IS the lat/lon and we skip the redundancy).
      if (!(crs && crs.kind === 'geographic')) {
        rows.push(coordGroupHeader('Geographic (WGS 84)'));
        rows.push(infoRow('Latitude', `${lat.toFixed(7)}°`));
        rows.push(infoRow('Longitude', `${lon.toFixed(7)}°`));
        if (typeof elev === 'number') {
          rows.push(infoRow('Elevation', `${elev.toFixed(3)} m`));
        }
      }
      // UTM grid — always shown when a geographic position exists.
      // The zone is derived from the position so the row is correct
      // regardless of the source CRS.
      const utm = latLonToUtm(lat, lon, elev);
      rows.push(
        coordGroupHeader(`UTM (zone ${utm.zone}${utm.hemisphere})`),
      );
      rows.push(infoRow('Easting', `${utm.easting.toFixed(3)} m`));
      rows.push(infoRow('Northing', `${utm.northing.toFixed(3)} m`));
      if (typeof utm.elevation === 'number') {
        rows.push(infoRow('Elevation', `${utm.elevation.toFixed(3)} m`));
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
    // ── Photometric witness — patch view + colour provenance ──────────────
    // The witness only renders when the cloud actually carries per-point
    // RGB (which the patch provider returns null for otherwise) and the
    // point's colour was reported on the PointInfo record. Section is
    // collapsible by <details> so it doesn't dominate the inspector
    // card; closed by default until the analyst opens it the first time.
    const witnessSection = this._buildWitnessSection(info);
    if (witnessSection) rows.push(witnessSection);

    this._cardBody.replaceChildren(...rows);
    this._copyNote.classList.add('olv-hidden');
    this._copyBtn.textContent = 'Copy';
  }

  /**
   * Build the photometric-witness section — a patch-view thumbnail and
   * the colour-provenance rows (scanner sRGB / linear / display sRGB).
   * Returns null when the cloud carries no RGB or the patch provider is
   * unset; the inspector then ships the classic numeric card unchanged.
   */
  private _buildWitnessSection(info: PointInfo): HTMLElement | null {
    if (!this._patchProvider) return null;
    if (!info.rgb) return null;
    const data = this._patchProvider(info.layer, info.index);
    if (!data) return null;
    // Build the patch — the data layer enforces bounds, so we just hand
    // it the index and let it return null on degenerate inputs.
    const patch = buildPatchView({
      pointIndex: info.index,
      positions: data.positions,
      colorsU8: data.colorsU8,
      size: 64,
      k: 64,
      splatRadius: 1.75,
    });
    if (!patch) return null;
    const cp = colorProvenance(info.rgb[0], info.rgb[1], info.rgb[2]);
    const fmt = formatColorProvenance(cp);

    // Render the patch into a small <canvas> for inline display.
    const canvas = document.createElement('canvas');
    canvas.width = patch.size;
    canvas.height = patch.size;
    canvas.className = 'olv-witness-canvas';
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const imageData = new ImageData(
        new Uint8ClampedArray(patch.rgba),
        patch.size,
        patch.size,
      );
      ctx.putImageData(imageData, 0, 0);
    }

    // Build the section — collapsible <details> so first-paint stays compact.
    const summary = document.createElement('summary');
    summary.className = 'olv-witness-summary';
    summary.textContent = 'Photometric witness';
    const grid = el('div', { className: 'olv-witness-grid' }, [
      canvas,
      el('div', { className: 'olv-witness-values' }, [
        witnessRow('Scanner', fmt.scanner),
        witnessRow('Linear', fmt.linear),
        witnessRow('Display', fmt.display),
        witnessRow(
          'Coverage',
          `${(patch.coverage * 100).toFixed(0)} %  ·  ${patch.hits} points`,
        ),
      ]),
    ]);
    const details = document.createElement('details');
    details.className = 'olv-witness-details';
    details.append(summary, grid);
    return details;
  }

  /** Copy the selected point's data to the clipboard, then confirm briefly. */
  private async _copy(): Promise<void> {
    if (!this._selected) return;
    const ok = await copyToClipboard(
      pointInfoCopyText(this._selected.info, this._classScopeStamp),
    );
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
    left = clamp(left, 12, w - cw - 12);
    const top = clamp(py - ch / 2, 12, h - ch - 12);
    this.card.style.left = `${left}px`;
    this.card.style.top = `${top}px`;
  }
}
