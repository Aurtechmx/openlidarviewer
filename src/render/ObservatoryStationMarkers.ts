/**
 * ObservatoryStationMarkers.ts: the Observatory's 3D station markers, drawn
 * through the same `derivedLayerHost()` seam as the shadow-voxel overlay and
 * loaded in the same lazy chunk (re-exported from `ObservatoryOverlay.ts`).
 *
 * Observed source stations get the solid glyph, suggested stations the
 * hollow dashed glyph plus the text label `SUGGESTED STATION (not observed)`
 * (OB-INV-05: labelled in 3D as in the panel). A station whose origin is
 * `ASSUMED` carries an `ASSUMED ORIGIN` caveat badge (OB-INV-04). The two
 * colours come from the Okabe-Ito colour-blind-safe set, and the glyph shapes
 * differ as well, so colour is never the only cue.
 *
 * PRESENTATION ONLY: this class is handed positions and labels. It never
 * writes a station into a run record; a suggested station stays a marker.
 * Labels are drawn with canvas `fillText`, as text only, never as markup.
 */
import * as THREE from 'three/webgpu';
import type { SceneOverlayHost } from './sceneLineOverlay';
import {
  buildObservedStationBuffer,
  buildSuggestedStationBuffer,
  type MarkerPosition,
} from './observatoryStationMarkerGeometry';

/** Okabe-Ito blue. */
export const OBSERVED_STATION_COLOR = 0x0072b2;
/** Okabe-Ito orange. */
export const SUGGESTED_STATION_COLOR = 0xe69f00;
export const ASSUMED_ORIGIN_BADGE = 'ASSUMED ORIGIN';

export interface ObservedStationMarker {
  readonly id: string;
  readonly position: MarkerPosition;
  readonly assumedOrigin: boolean;
}

export interface SuggestedStationMarker {
  readonly rank: number;
  readonly position: MarkerPosition;
}

export interface StationMarkerInput {
  readonly observed: readonly ObservedStationMarker[];
  readonly suggested: readonly SuggestedStationMarker[];
  readonly size: number;
  /** The one shared label constant (`stationSuggestion.ts#SUGGESTED_STATION_LABEL`), passed in so this chunk does not import the kernel. */
  readonly suggestedLabel: string;
}

/** One text label as placed in the scene, kept for inspection and tests. */
export interface PlacedMarkerLabel {
  readonly text: string;
  readonly position: MarkerPosition;
  readonly kind: 'observed' | 'suggested' | 'caveat';
}

function makeLines(color: number, name: string): THREE.LineSegments {
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  lines.name = name;
  lines.frustumCulled = false;
  lines.renderOrder = 6;
  return lines;
}

function setPositions(lines: THREE.LineSegments, verts: Float32Array): void {
  lines.geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  lines.geometry.computeBoundingSphere();
  lines.visible = verts.length > 0;
}

/** A canvas text sprite, or `null` where no 2D canvas exists (unit tests under node). */
function textSprite(text: string, color: number, worldHeight: number): THREE.Sprite | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) return null;
  const fontPx = 28;
  ctx.font = `600 ${fontPx}px sans-serif`;
  const width = Math.ceil(ctx.measureText(text).width) + 16;
  canvas.width = width;
  canvas.height = fontPx + 12;
  ctx.font = `600 ${fontPx}px sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(worldHeight * (canvas.width / canvas.height), worldHeight, 1);
  sprite.renderOrder = 7;
  return sprite;
}

export class ObservatoryStationMarkers {
  private readonly host: SceneOverlayHost;
  private readonly group = new THREE.Group();
  private readonly observedLines = makeLines(OBSERVED_STATION_COLOR, 'olv-observatory-station-observed');
  private readonly suggestedLines = makeLines(SUGGESTED_STATION_COLOR, 'olv-observatory-station-suggested');
  private sprites: THREE.Sprite[] = [];
  private placed: PlacedMarkerLabel[] = [];
  private attached = false;
  private disposed = false;

  constructor(host: SceneOverlayHost) {
    this.host = host;
    this.group.name = 'olv-observatory-stations';
    this.group.add(this.observedLines, this.suggestedLines);
  }

  /** The labels currently placed, in draw order. */
  labels(): readonly PlacedMarkerLabel[] {
    return this.placed;
  }

  /** Draw both marker sets, replacing any previous ones; an empty input clears. */
  show(input: StationMarkerInput): void {
    if (this.disposed) return;
    this.dropSprites();
    if (input.observed.length === 0 && input.suggested.length === 0) {
      this.clear();
      return;
    }
    setPositions(this.observedLines, buildObservedStationBuffer(input.observed.map((s) => s.position), input.size));
    setPositions(this.suggestedLines, buildSuggestedStationBuffer(input.suggested.map((s) => s.position), input.size));

    const labelHeight = input.size * 0.35;
    const above = (p: MarkerPosition, k: number): MarkerPosition => [p[0], p[1], p[2] + input.size * (0.6 + 0.45 * k)];
    const placed: PlacedMarkerLabel[] = [];
    for (const s of input.observed) {
      placed.push({ text: s.id, position: above(s.position, 0), kind: 'observed' });
      if (s.assumedOrigin) placed.push({ text: ASSUMED_ORIGIN_BADGE, position: above(s.position, 1), kind: 'caveat' });
    }
    for (const s of input.suggested) {
      placed.push({ text: `${input.suggestedLabel} ${s.rank}`, position: above(s.position, 0), kind: 'suggested' });
    }
    for (const label of placed) {
      const color = label.kind === 'suggested' ? SUGGESTED_STATION_COLOR : label.kind === 'caveat' ? 0xffffff : OBSERVED_STATION_COLOR;
      const sprite = textSprite(label.text, color, labelHeight);
      if (!sprite) continue;
      sprite.position.set(label.position[0], label.position[1], label.position[2]);
      this.sprites.push(sprite);
      this.group.add(sprite);
    }
    this.placed = placed;
    this.group.visible = true;
    if (!this.attached) {
      this.host.add(this.group);
      this.attached = true;
    }
    this.host.requestFrame();
  }

  clear(): void {
    this.dropSprites();
    this.placed = [];
    if (this.attached) {
      this.host.remove(this.group);
      this.attached = false;
    }
    this.group.visible = false;
    this.host.requestFrame();
  }

  /** Detach and release every GPU resource. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    for (const lines of [this.observedLines, this.suggestedLines]) {
      lines.geometry.dispose();
      (lines.material as THREE.Material).dispose();
    }
  }

  private dropSprites(): void {
    for (const sprite of this.sprites) {
      this.group.remove(sprite);
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
    this.sprites = [];
  }
}
