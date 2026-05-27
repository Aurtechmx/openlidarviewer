/**
 * MeasureOverlay.ts
 *
 * The SVG drawing layer for the measurement toolkit. It owns one `<svg>` and,
 * each frame, projects a measurement "draw model" — 3D polygons, edges,
 * vertices and labels — to screen space and renders crisp markers, fills and
 * anti-overlap labels.
 *
 * SVG (not three.js geometry) sidesteps the WebGPU one-pixel line/point limit
 * and renders identically on both GPU backends. Browser-bound: not imported in
 * Node tests.
 */

import * as THREE from 'three/webgpu';
import type { Vec3 } from '../navMath';
import { layoutLabels } from './labelLayout';
import type { LabelBox } from './labelLayout';
import { standaloneSvg, viewBoxSize } from '../snapshotSvg';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Self-contained measurement styling for the screenshot export. The live
 * overlay is styled by the app stylesheet; a serialised SVG rasterised on its
 * own cannot reach it, so the snapshot carries these rules inline. Kept in
 * sync with the `.olv-measure-*` / `.olv-m-*` blocks in `style.css`, with the
 * accent colour resolved to its literal value.
 */
// v0.3.2 polish — stroke widths match the live CSS (≈10% bump over the
// original v0.2 measure values) so a baked-into-export measurement reads
// at the same weight the user sees on-screen.
const SNAPSHOT_CSS = [
  '.olv-measure-line{stroke:#00b2ff;stroke-width:1.75;stroke-dasharray:6 4}',
  '.olv-m-preview{opacity:0.5}',
  '.olv-measure-dot{fill:#00b2ff;stroke:#0a0e1a;stroke-width:1.65}',
  '.olv-measure-dot-pending{fill:none;stroke:#00b2ff;stroke-width:2.2}',
  '.olv-m-fill{fill:rgba(0,178,255,0.14);stroke:#00b2ff;stroke-width:1.45;stroke-dasharray:5 4}',
  '.olv-m-leader{stroke:rgba(0,178,255,0.5);stroke-width:1.1}',
  '.olv-m-handle{fill:transparent}',
  '.olv-measure-label{fill:#00b2ff;font:600 12px ui-monospace,"SF Mono",Menlo,Consolas,monospace;',
  'paint-order:stroke;stroke:#0a0e1a;stroke-width:4px;stroke-linejoin:round}',
  '.olv-m-label-primary{font-size:13px}',
].join('');

/** A vertex marker. */
export interface OverlayVertex {
  p: Vec3;
  /** `pending` = the most recently placed point of an in-progress measurement. */
  role: 'normal' | 'pending';
  /** When set, this vertex is a draggable edit handle. */
  handle?: { mid: string; vi: number };
}

/** A line segment between two world points. */
export interface OverlayEdge {
  a: Vec3;
  b: Vec3;
  /** `preview` edges are faded rubber-bands toward the cursor. */
  style: 'solid' | 'preview';
}

/** A filled polygon (area measurement). */
export interface OverlayPolygon {
  points: Vec3[];
}

/** A value label anchored at a world point. */
export interface OverlayLabel {
  anchor: Vec3;
  text: string;
  /** Primary labels (the headline value) render larger. */
  primary: boolean;
}

/** Everything to draw for one frame. */
export interface OverlayModel {
  polygons: OverlayPolygon[];
  edges: OverlayEdge[];
  vertices: OverlayVertex[];
  labels: OverlayLabel[];
}

/** A projected screen point. */
interface Projected {
  x: number;
  y: number;
  visible: boolean;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Rough on-screen width of a label, for the anti-overlap layout. */
function estimateWidth(text: string, primary: boolean): number {
  return text.length * (primary ? 7.6 : 6.3) + 14;
}

export class MeasureOverlay {
  /** The `<svg>` element — mount into the stage overlay. */
  readonly element: SVGSVGElement;

  private readonly _ndc = new THREE.Vector3();
  private readonly _cameraSpace = new THREE.Vector3();
  private readonly _world = new THREE.Vector3();

  constructor() {
    this.element = document.createElementNS(SVG_NS, 'svg');
    this.element.setAttribute('class', 'olv-measure-svg');
  }

  /** Project all measurement geometry and redraw. Call once per frame. */
  render(model: OverlayModel, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.element.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const kids: SVGElement[] = [];

    // Filled polygons sit behind everything else.
    for (const poly of model.polygons) {
      const pts = poly.points.map((p) => this._project(p, camera, w, h));
      if (pts.length < 3 || pts.some((p) => !p.visible)) continue;
      kids.push(
        svg('polygon', {
          points: pts.map((p) => `${p.x},${p.y}`).join(' '),
          class: 'olv-m-fill',
        }),
      );
    }

    // Edges.
    for (const e of model.edges) {
      const a = this._project(e.a, camera, w, h);
      const b = this._project(e.b, camera, w, h);
      if (!a.visible || !b.visible) continue;
      kids.push(
        svg('line', {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          class: e.style === 'preview' ? 'olv-measure-line olv-m-preview' : 'olv-measure-line',
        }),
      );
    }

    // Vertices, with an invisible larger hit-circle for draggable handles.
    for (const vx of model.vertices) {
      const p = this._project(vx.p, camera, w, h);
      if (!p.visible) continue;
      kids.push(
        svg('circle', {
          cx: p.x,
          cy: p.y,
          r: vx.role === 'pending' ? 5 : 4.2,
          class:
            vx.role === 'pending'
              ? 'olv-measure-dot olv-measure-dot-pending'
              : 'olv-measure-dot',
        }),
      );
      if (vx.handle) {
        const hit = svg('circle', { cx: p.x, cy: p.y, r: 12, class: 'olv-m-handle' });
        hit.setAttribute('data-mid', vx.handle.mid);
        hit.setAttribute('data-vi', String(vx.handle.vi));
        kids.push(hit);
      }
    }

    // Labels — projected, then nudged apart so values never overlap.
    const onScreen = model.labels
      .map((l) => ({ l, p: this._project(l.anchor, camera, w, h) }))
      .filter((x) => x.p.visible);
    const boxes: LabelBox[] = onScreen.map((x) => ({
      x: x.p.x,
      y: x.p.y - 16,
      width: estimateWidth(x.l.text, x.l.primary),
      height: x.l.primary ? 18 : 15,
    }));
    const placed = layoutLabels(boxes);
    onScreen.forEach((x, i) => {
      const at = placed[i];
      if (at.displaced) {
        kids.push(
          svg('line', { x1: x.p.x, y1: x.p.y, x2: at.x, y2: at.y, class: 'olv-m-leader' }),
        );
      }
      const text = svg('text', {
        x: at.x,
        y: at.y,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        class: x.l.primary ? 'olv-measure-label olv-m-label-primary' : 'olv-measure-label',
      });
      text.textContent = x.l.text;
      kids.push(text);
    });

    this.element.replaceChildren(...kids);
  }

  /** Clear all drawn geometry. */
  clear(): void {
    this.element.replaceChildren();
  }

  /**
   * Serialise the current frame's geometry to a standalone, self-styled SVG
   * string for the screenshot compositor. The document carries its own
   * `<style>` so it rasterises correctly without the app stylesheet.
   */
  toSVGString(): string {
    const [w, h] = viewBoxSize(this.element);
    const serializer = new XMLSerializer();
    let inner = '';
    for (const child of Array.from(this.element.children)) {
      inner += serializer.serializeToString(child);
    }
    return standaloneSvg(inner, w, h, SNAPSHOT_CSS);
  }

  /** Remove the SVG element from the DOM. */
  dispose(): void {
    this.element.remove();
  }

  /** Project a world point to canvas pixels; `visible` is false when behind. */
  private _project(
    p: Vec3,
    camera: THREE.PerspectiveCamera,
    w: number,
    h: number,
  ): Projected {
    this._world.set(p[0], p[1], p[2]);
    this._cameraSpace.copy(this._world).applyMatrix4(camera.matrixWorldInverse);
    const inFront = this._cameraSpace.z < 0; // the camera looks down -Z
    this._ndc.copy(this._world).project(camera);
    return {
      x: (this._ndc.x * 0.5 + 0.5) * w,
      y: (-this._ndc.y * 0.5 + 0.5) * h,
      visible: inFront,
    };
  }
}
