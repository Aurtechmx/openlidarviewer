/**
 * AnnotationOverlay.ts
 *
 * The SVG marker layer for annotations. Unlike the measurement overlay, which
 * rebuilds its DOM every frame, this overlay keeps one persistent `<g>` per
 * annotation: a frame only updates each marker's `transform` and visibility —
 * a compositor-only change, no layout — so 250+ markers cost no frame budget.
 *
 * SVG renders identically on the WebGPU and WebGL 2 backends and is naturally
 * screen-space (markers stay a fixed pixel size at any zoom). Browser-bound —
 * not imported in Node tests.
 */

import * as THREE from 'three/webgpu';
import type { Annotation, AnnotationType } from './types';
import { standaloneSvg, viewBoxSize } from '../snapshotSvg';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Marker disc radius in CSS pixels — fixed screen-space, zoom-stable. */
const MARKER_R = 11;

/**
 * Self-contained marker styling for the screenshot export. The live overlay is
 * styled by the app stylesheet; a serialised SVG rasterised on its own cannot
 * reach it, so the snapshot carries these rules inline. Kept in sync with the
 * `.olv-anno-*` block in `style.css`; the transient hover/selected states are
 * deliberately omitted — a static evidence export should not single one out.
 */
const SNAPSHOT_CSS = [
  '.olv-anno-halo{fill:rgba(8,13,20,0.82)}',
  '.olv-anno-disc{stroke:rgba(8,13,20,0.9);stroke-width:1}',
  '.olv-anno-num{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;',
  'font-size:12px;font-weight:700}',
  '.olv-anno-note .olv-anno-disc{fill:#5b9bd5}',
  '.olv-anno-info .olv-anno-disc{fill:#22dcff}',
  '.olv-anno-warning .olv-anno-disc{fill:#f0b429}',
  '.olv-anno-issue .olv-anno-disc{fill:#e24b4a}',
  '.olv-anno-note .olv-anno-num,.olv-anno-info .olv-anno-num,',
  '.olv-anno-warning .olv-anno-num{fill:#06121a}',
  '.olv-anno-issue .olv-anno-num{fill:#fff}',
].join('');

/** The persistent DOM for one annotation marker. */
interface Marker {
  group: SVGGElement;
  label: SVGTextElement;
  /** The annotation's local position, cached for per-frame projection. */
  pos: THREE.Vector3;
  type: AnnotationType;
}

/** The CSS class carrying a type's colour. */
function typeClass(t: AnnotationType): string {
  return `olv-anno-${t}`;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

export class AnnotationOverlay {
  /** The `<svg>` element — mount into the stage overlay. */
  readonly element: SVGSVGElement;

  private readonly _markers = new Map<string, Marker>();
  private readonly _ndc = new THREE.Vector3();
  private readonly _cam = new THREE.Vector3();
  private _onMarkerClick: ((id: string) => void) | null = null;

  constructor() {
    this.element = svgEl('svg');
    this.element.setAttribute('class', 'olv-anno-svg');
    // A click anywhere inside a marker group resolves to its annotation id.
    this.element.addEventListener('click', (e) => {
      const target = e.target as Element | null;
      const id = target?.closest('[data-aid]')?.getAttribute('data-aid');
      if (id) this._onMarkerClick?.(id);
    });
  }

  /** Register the handler called with an annotation id when its marker is clicked. */
  setOnMarkerClick(cb: (id: string) => void): void {
    this._onMarkerClick = cb;
  }

  /**
   * Reconcile the marker elements with the annotation list — create groups for
   * new annotations, drop them for deleted ones, refresh index numbers and
   * type/selection styling. Called on change, never per frame.
   */
  sync(annotations: Annotation[], selectedId: string | null): void {
    const seen = new Set<string>();
    annotations.forEach((a, i) => {
      seen.add(a.id);
      let m = this._markers.get(a.id);
      if (!m) {
        m = this._createMarker(a);
        this._markers.set(a.id, m);
        this.element.append(m.group);
      }
      m.label.textContent = String(i + 1);
      m.pos.set(a.localPosition.x, a.localPosition.y, a.localPosition.z);
      if (m.type !== a.type) {
        m.group.classList.remove(typeClass(m.type));
        m.group.classList.add(typeClass(a.type));
        m.type = a.type;
      }
      m.group.classList.toggle('olv-anno-selected', a.id === selectedId);
    });
    for (const [id, m] of this._markers) {
      if (!seen.has(id)) {
        m.group.remove();
        this._markers.delete(id);
      }
    }
  }

  /** Per-frame: project each marker and update its transform and visibility. */
  render(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.element.setAttribute('viewBox', `0 0 ${w} ${h}`);
    for (const m of this._markers.values()) {
      // Behind the camera (the camera looks down -Z) — hide the marker.
      this._cam.copy(m.pos).applyMatrix4(camera.matrixWorldInverse);
      if (this._cam.z >= 0) {
        m.group.style.display = 'none';
        continue;
      }
      this._ndc.copy(m.pos).project(camera);
      const x = (this._ndc.x * 0.5 + 0.5) * w;
      const y = (-this._ndc.y * 0.5 + 0.5) * h;
      if (x < -40 || y < -40 || x > w + 40 || y > h + 40) {
        m.group.style.display = 'none';
        continue;
      }
      m.group.style.display = '';
      m.group.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    }
  }

  /** Set the hovered marker (pass `null` to clear). */
  setHovered(id: string | null): void {
    for (const [mid, m] of this._markers) {
      m.group.classList.toggle('olv-anno-hover', mid === id);
    }
  }

  /**
   * Serialise the on-screen markers to a standalone, self-styled SVG string
   * for the screenshot compositor. Only markers visible this frame are
   * included; the document carries its own `<style>` so it rasterises with the
   * correct type colours without the app stylesheet.
   */
  toSVGString(): string {
    const [w, h] = viewBoxSize(this.element);
    const serializer = new XMLSerializer();
    let inner = '';
    for (const m of this._markers.values()) {
      // Skip markers culled behind the camera or off-screen this frame.
      if (m.group.style.display === 'none') continue;
      inner += serializer.serializeToString(m.group);
    }
    return standaloneSvg(inner, w, h, SNAPSHOT_CSS);
  }

  /** Remove the SVG element and drop all marker references. */
  dispose(): void {
    this._markers.clear();
    this.element.remove();
  }

  private _createMarker(a: Annotation): Marker {
    const group = svgEl('g');
    group.setAttribute('class', `olv-anno-marker ${typeClass(a.type)}`);
    group.setAttribute('data-aid', a.id);

    // Dark halo for readability over a dense, bright cloud, then the type disc.
    const halo = svgEl('circle');
    halo.setAttribute('r', String(MARKER_R + 1.5));
    halo.setAttribute('class', 'olv-anno-halo');
    const disc = svgEl('circle');
    disc.setAttribute('r', String(MARKER_R));
    disc.setAttribute('class', 'olv-anno-disc');

    const label = svgEl('text');
    label.setAttribute('class', 'olv-anno-num');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.textContent = '1';

    group.append(halo, disc, label);
    return {
      group,
      label,
      pos: new THREE.Vector3(a.localPosition.x, a.localPosition.y, a.localPosition.z),
      type: a.type,
    };
  }
}
