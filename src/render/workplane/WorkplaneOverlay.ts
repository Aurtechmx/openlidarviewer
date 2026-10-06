/**
 * WorkplaneOverlay.ts
 *
 * The three.js binding of the reference grid: three line sets (minor, major,
 * axes and origin marker) under one group placed at the anchor. The buffers
 * and the per-vertex fade come from `workplaneGeometry.ts`; this file only
 * uploads them, styles them and releases them.
 *
 * Visual only. Picking in this app is a ray against the scan's own points,
 * never a scene-graph raycast, so these lines cannot be picked, measured or
 * snapped to. `raycast` is also emptied, so a future scene raycast would skip
 * them as well.
 *
 * Depth: the lines test depth and never write it. They are transparent, so
 * they draw after the scan's opaque points: a point in front of a line hides
 * it, and a line can never hide a point, because it leaves no depth behind.
 * Polygon offset does not apply to line primitives, so nothing here relies on
 * it; a point lying exactly on the plane may share pixels with a line.
 *
 * Lifetime: GPU buffers exist only while the plane is drawn. `dispose()`
 * detaches the group and frees every geometry and material; the CPU arrays
 * stay on the geometry until then, which is what lets a renderer rebuilt after
 * a WebGL context loss upload them again.
 */

import * as THREE from 'three/webgpu';
import type { SceneOverlayHost } from '../sceneLineOverlay';
import type { WorkplaneGeometry } from './workplaneGeometry';

type Rgb = readonly [number, number, number];

interface LineStyle {
  readonly color: Rgb;
  readonly opacity: number;
}

/**
 * Line styles for a dark backdrop and a light one. Low contrast on purpose:
 * the scan is the subject. Major lines carry about three times the minor
 * lines' opacity so the two read apart; the axes are a warm hue at higher
 * opacity, and also differ by being the only lines through the origin marker.
 */
export const WORKPLANE_STYLES: Readonly<Record<'dark' | 'light', Record<'minor' | 'major' | 'axes', LineStyle>>> = {
  dark: {
    minor: { color: [0.62, 0.68, 0.76], opacity: 0.06 },
    major: { color: [0.7, 0.76, 0.84], opacity: 0.19 },
    axes: { color: [0.95, 0.72, 0.32], opacity: 0.5 },
  },
  light: {
    minor: { color: [0.24, 0.27, 0.32], opacity: 0.07 },
    major: { color: [0.18, 0.21, 0.26], opacity: 0.21 },
    axes: { color: [0.6, 0.3, 0.02], opacity: 0.55 },
  },
};

export const WORKPLANE_KINDS = ['minor', 'major', 'axes'] as const;
export type WorkplaneKind = (typeof WORKPLANE_KINDS)[number];

export class WorkplaneOverlay {
  private readonly _host: SceneOverlayHost;
  private _group: THREE.Group | null = null;
  private readonly _lines = new Map<WorkplaneKind, THREE.LineSegments>();
  private _backdrop: 'dark' | 'light' = 'dark';

  constructor(host: SceneOverlayHost) {
    this._host = host;
  }

  /** Geometries plus materials currently allocated (0 after dispose). */
  get liveResources(): number {
    return this._lines.size * 2;
  }

  /** Replace the drawn grid with `geom`. Creates the scene objects on first use. */
  update(geom: WorkplaneGeometry): void {
    const group = this._ensureGroup();
    group.position.set(geom.anchorScene[0], geom.anchorScene[1], geom.anchorScene[2]);
    for (const kind of WORKPLANE_KINDS) this._setBuffer(kind, geom[kind].vertices);
    group.updateMatrixWorld(true);
    this._host.requestFrame();
  }

  /** Per-vertex fade for one line set, 0..1, same vertex order as its positions. */
  setAlphas(kind: WorkplaneKind, alphas: Float32Array): void {
    const lines = this._lines.get(kind);
    const attr = lines?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr || attr.count !== alphas.length) return;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < alphas.length; i++) arr[i * 4 + 3] = alphas[i];
    attr.needsUpdate = true;
    this._host.requestFrame();
  }

  /** Restyle for a dark or light backdrop. */
  setBackdrop(backdrop: 'dark' | 'light'): void {
    if (backdrop === this._backdrop) return;
    this._backdrop = backdrop;
    for (const [kind, lines] of this._lines) applyStyle(lines.material as THREE.LineBasicMaterial, WORKPLANE_STYLES[backdrop][kind]);
    this._host.requestFrame();
  }

  /** Show or hide without freeing anything (an export that must not carry the plane). */
  setVisible(visible: boolean): void {
    if (!this._group || this._group.visible === visible) return;
    this._group.visible = visible;
    this._host.requestFrame();
  }

  /** Detach and free every GPU resource. Idempotent; `update` rebuilds. */
  dispose(): void {
    if (this._group) this._host.remove(this._group);
    for (const lines of this._lines.values()) {
      lines.geometry.dispose();
      (lines.material as THREE.Material).dispose();
    }
    this._lines.clear();
    this._group = null;
    this._host.requestFrame();
  }

  private _ensureGroup(): THREE.Group {
    if (this._group) return this._group;
    const group = new THREE.Group();
    group.name = 'olv-reference-plane';
    group.raycast = () => {};
    this._host.add(group);
    this._group = group;
    return group;
  }

  private _setBuffer(kind: WorkplaneKind, positions: Float32Array): void {
    let lines = this._lines.get(kind);
    if (!lines) {
      const material = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, depthTest: true, vertexColors: true });
      applyStyle(material, WORKPLANE_STYLES[this._backdrop][kind]);
      lines = new THREE.LineSegments(new THREE.BufferGeometry(), material);
      lines.name = `olv-reference-plane-${kind}`;
      lines.frustumCulled = false;
      // Under the scan's derived overlays (contours draw at 2); axes over the lattice.
      lines.renderOrder = kind === 'axes' ? 1.5 : 1;
      lines.raycast = () => {};
      this._lines.set(kind, lines);
      this._group!.add(lines);
    }
    // A new geometry per update: the vertex count changes with the zoom, and a
    // buffer resized in place is not something both backends accept.
    const previous = lines.geometry;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // White RGB times the material colour; the alpha channel carries the fade.
    const colour = new Float32Array((positions.length / 3) * 4).fill(1);
    geometry.setAttribute('color', new THREE.BufferAttribute(colour, 4));
    lines.geometry = geometry;
    lines.visible = positions.length > 0;
    previous.dispose();
  }
}

function applyStyle(material: THREE.LineBasicMaterial, style: LineStyle): void {
  material.color.setRGB(style.color[0], style.color[1], style.color[2]);
  material.opacity = style.opacity;
  material.needsUpdate = true;
}
