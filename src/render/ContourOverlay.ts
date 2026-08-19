/**
 * ContourOverlay.ts
 *
 * The thin three.js binding that draws analysed contours in the 3D scene — the
 * first real Derived Layer. Everything that can be decided without three lives
 * next door in `contourOverlayPlacement.ts` (which frame, which position) and in
 * `terrain/contour/contourOverlayGeometry.ts` (the line buffers), both pure and
 * unit-tested. What remains here is upload, style, and lifecycle.
 *
 * FRAME (load-bearing). The buffers are built through
 * `overlayBufferParamsFor(format)`, which returns the vertical axis and the
 * northing sign TOGETHER. Taking only the axis for a Y-up scan is a reflection
 * that mirrors the scan while still looking like a contour map; the pairing is
 * what makes that unreachable from here. See the proof in
 * `tests/contourOverlayPlacement.test.ts`.
 *
 * EVIDENCE HONESTY. A contour's grade is not decoration: `solid` means measured
 * support, `dashed` means interpolated. The overlay distinguishes them by colour
 * and alpha rather than by a dash PATTERN — a screen-space dash length is
 * meaningless at an arbitrary 3D zoom, and a dashed line that reads as solid
 * when you fly close would be the dishonest option. `gap` segments are excluded
 * by the geometry builder's default: a gap is a break, not a line, so nothing is
 * drawn across it. Index contours are brightened, never re-shaped.
 *
 * The elevations drawn are the analysed elevations. `heightOffset` lifts the
 * whole object along the scene's vertical axis so the lines read ON the surface
 * instead of z-fighting the points that produced them; it is a DISPLAY nudge and
 * never changes the geometry, the readouts, or any export.
 */

import * as THREE from 'three/webgpu';
import {
  buildContourOverlayBuffers,
  type ContourOverlayBuffers,
} from '../terrain/contour/contourOverlayGeometry';
import type { ContourFeatureModel } from '../terrain/contour/contourFeatureModel';
import type { SourceFormat } from '../io/sniffFormat';
import {
  overlayBufferParamsFor,
  overlayVerticalAxisFor,
  overlayScenePosition,
  overlayHeightOffsetVector,
} from './contourOverlayPlacement';

/**
 * What the overlay needs from its host. A `THREE.Scene` satisfies add/remove as
 *-is; `requestFrame` is the Viewer's redraw request. Narrow on purpose, so the
 * overlay can be exercised without standing up a renderer.
 */
export interface ContourOverlayHost {
  add(object: THREE.Object3D): void;
  remove(object: THREE.Object3D): void;
  requestFrame?: () => void;
}

/** What to draw, and the frame of the scan it belongs to. */
export interface ContourOverlayInput {
  readonly model: ContourFeatureModel;
  /** The source format of the scan the contours were derived from (fixes the frame). */
  readonly format: SourceFormat;
  /** The scan's render-recentre origin, so the lines land over their own terrain. */
  readonly renderOrigin: readonly [number, number, number] | null;
  /** Vertical exaggeration currently applied to the scene. Default 1. */
  readonly zScale?: number;
}

/** Colours, chosen to read against both the dark and light scene presets. */
const SOLID_RGB: readonly [number, number, number] = [0.36, 0.85, 1.0];
const DASHED_RGB: readonly [number, number, number] = [0.55, 0.66, 0.74];
/** Index (bold) contours are the same hue, brighter — emphasis, not a new class. */
const INDEX_GAIN = 1.25;
/** Interpolated support also drops alpha, so it recedes as well as desaturates. */
const DASHED_ALPHA = 0.55;

const GRADE_SOLID = 0;

export class ContourOverlay {
  private readonly _host: ContourOverlayHost;
  private _lines: THREE.LineSegments | null = null;
  private _geometry: THREE.BufferGeometry | null = null;
  private _material: THREE.LineBasicNodeMaterial | null = null;
  private _verticalAxis: 'z' | 'y' = 'z';
  private _basePosition: [number, number, number] = [0, 0, 0];
  private _heightOffset = 0;
  private _visible = true;
  private _opacity = 1;
  private _indexEmphasis = true;
  /** Segment count of the current upload — 0 when nothing is drawn. */
  private _segmentCount = 0;

  constructor(host: ContourOverlayHost) {
    this._host = host;
  }

  /** Segments currently uploaded. 0 means the overlay draws nothing. */
  get segmentCount(): number {
    return this._segmentCount;
  }

  /** The scene object, for a host that needs to inspect it. Null before the first build. */
  get object(): THREE.Object3D | null {
    return this._lines;
  }

  /**
   * Build (or rebuild) the drawn geometry from an analysed contour model. Safe to
   * call repeatedly: the previous GPU resources are released first, so a
   * re-analysis cannot leak buffers.
   */
  setModel(input: ContourOverlayInput): void {
    const { verticalAxis, negateNorthing } = overlayBufferParamsFor(input.format);
    const buffers = buildContourOverlayBuffers(input.model, {
      verticalAxis,
      negateNorthing,
      zScale: input.zScale ?? 1,
    });
    this._verticalAxis = overlayVerticalAxisFor(input.format);
    this._basePosition = overlayScenePosition(input.renderOrigin);
    this._upload(buffers);
    this._applyTransform();
    this._applyMaterialState();
    this._host.requestFrame?.();
  }

  /** Show or hide without discarding the uploaded geometry. */
  setVisible(visible: boolean): void {
    this._visible = visible;
    this._applyMaterialState();
    this._host.requestFrame?.();
  }

  /** 0..1, clamped. */
  setOpacity(opacity: number): void {
    const o = Number.isFinite(opacity) ? opacity : 1;
    this._opacity = o < 0 ? 0 : o > 1 ? 1 : o;
    this._applyMaterialState();
    this._host.requestFrame?.();
  }

  /** Brighten index (bold) contours. Emphasis only — geometry is untouched. */
  setIndexEmphasis(on: boolean): void {
    if (this._indexEmphasis === on) return;
    this._indexEmphasis = on;
    // The emphasis is baked into the vertex colours, so it needs a recolour of
    // the existing upload rather than a material flag.
    this._recolour();
    this._host.requestFrame?.();
  }

  /**
   * Lift the lines along the scene's vertical axis so they sit ON the surface.
   * Display only: the contour elevations are unchanged.
   */
  setHeightOffset(offset: number): void {
    this._heightOffset = Number.isFinite(offset) ? offset : 0;
    this._applyTransform();
    this._host.requestFrame?.();
  }

  /** Remove from the scene and release every GPU resource. Idempotent. */
  dispose(): void {
    if (this._lines) this._host.remove(this._lines);
    this._geometry?.dispose();
    this._material?.dispose();
    this._lines = null;
    this._geometry = null;
    this._material = null;
    this._segmentCount = 0;
    this._host.requestFrame?.();
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Replace the uploaded geometry with `buffers`, creating the object if needed. */
  private _upload(buffers: ContourOverlayBuffers): void {
    // Drop the previous upload first: a re-analysis replaces every vertex, and
    // reusing a geometry sized for the old model would leave a stale tail drawn.
    if (this._lines) this._host.remove(this._lines);
    this._geometry?.dispose();

    this._segmentCount = buffers.segmentCount;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(vertexColours(buffers, this._indexEmphasis), 3),
    );
    this._geometry = geometry;
    // Kept so a later recolour knows what each vertex was, without re-deriving.
    this._grades = buffers.grades;
    this._isIndex = buffers.isIndex;

    if (!this._material) {
      const material = new THREE.LineBasicNodeMaterial();
      material.vertexColors = true;
      material.transparent = true;
      // Contours describe the surface under them; drawn without depth-write they
      // stay visible where the cloud is dense without punching a hole in it.
      material.depthWrite = false;
      this._material = material;
    }

    const lines = new THREE.LineSegments(geometry, this._material);
    // Derived overlays draw after the cloud so a thin line is not swallowed by
    // point splats at the same depth.
    lines.renderOrder = 2;
    // The scan can be far from the scene origin; its own bounds are meaningless
    // for culling once the object is offset to the render origin.
    lines.frustumCulled = false;
    this._lines = lines;
    this._host.add(lines);
  }

  private _grades: Uint8Array = new Uint8Array(0);
  private _isIndex: Uint8Array = new Uint8Array(0);

  /** Rebuild the colour attribute in place from the retained grade/index arrays. */
  private _recolour(): void {
    if (!this._geometry || this._segmentCount === 0) return;
    const colours = vertexColours(
      { segmentCount: this._segmentCount, grades: this._grades, isIndex: this._isIndex },
      this._indexEmphasis,
    );
    const attr = this._geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (attr && attr.array.length === colours.length) {
      (attr.array as Float32Array).set(colours);
      attr.needsUpdate = true;
    } else {
      this._geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    }
  }

  private _applyTransform(): void {
    if (!this._lines) return;
    const lift = overlayHeightOffsetVector(this._verticalAxis, this._heightOffset);
    this._lines.position.set(
      this._basePosition[0] + lift[0],
      this._basePosition[1] + lift[1],
      this._basePosition[2] + lift[2],
    );
  }

  private _applyMaterialState(): void {
    if (this._lines) this._lines.visible = this._visible && this._segmentCount > 0;
    if (this._material) this._material.opacity = this._opacity;
  }
}

/**
 * Per-VERTEX colours from per-SEGMENT grades: two vertices per segment, so each
 * segment's colour is written twice. Exported for the unit test, which is what
 * pins the evidence-honesty mapping (interpolated support must not render the
 * same as measured support).
 */
export function vertexColours(
  buffers: Pick<ContourOverlayBuffers, 'segmentCount' | 'grades' | 'isIndex'>,
  indexEmphasis: boolean,
): Float32Array {
  const out = new Float32Array(buffers.segmentCount * 6);
  for (let s = 0; s < buffers.segmentCount; s++) {
    const solid = buffers.grades[s] === GRADE_SOLID;
    const base = solid ? SOLID_RGB : DASHED_RGB;
    const gain = indexEmphasis && buffers.isIndex[s] === 1 ? INDEX_GAIN : 1;
    // Interpolated support recedes: dimmer hue AND lower alpha. Alpha rides in
    // the colour here because the material's opacity is the layer-wide control.
    const a = solid ? 1 : DASHED_ALPHA;
    const r = Math.min(1, base[0] * gain * a);
    const g = Math.min(1, base[1] * gain * a);
    const b = Math.min(1, base[2] * gain * a);
    const o = s * 6;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = r;
    out[o + 4] = g;
    out[o + 5] = b;
  }
  return out;
}
