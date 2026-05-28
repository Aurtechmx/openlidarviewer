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
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    this.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);

    if (!this._selected) {
      this.overlay.replaceChildren();
      return;
    }
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
    const rows: HTMLElement[] = [
      infoRow('X', `${info.x} m`),
      infoRow('Y', `${info.y} m`),
      infoRow('Z', `${info.z} m`),
      infoRow('Distance', `${info.distance} m`),
      infoRow('Intensity', intensityText(info)),
      infoRow('Classification', classificationText(info)),
      infoRow('RGB', rgbText(info)),
    ];
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
