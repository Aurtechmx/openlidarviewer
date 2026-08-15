/**
 * DerivedLayer.ts — the model for analytical layers computed FROM scans.
 *
 * Terrain surfaces, contours, change rasters, and extracted features all get
 * computed and then shown in a panel or written to an export. There is no shared
 * scene abstraction for them, so each feature invents its own render/UI path. A
 * `DerivedLayer` is that shared abstraction: a named, provenance-carrying result
 * derived from one or more source scans, with the display state (visibility,
 * opacity, style) a scene layer needs. This module is the pure model and its
 * store — no three.js, no DOM. The renderer that draws a derived layer, and the
 * Layers-panel section that lists it, consume this; they are a later step.
 */

export type DerivedLayerType =
  | 'dtm-mesh'
  | 'dsm-mesh'
  | 'contours'
  | 'slope'
  | 'hillshade'
  | 'change-raster'
  | 'building-polygons'
  | 'conductor-lines';

/** Axis-aligned bounds `[minX, minY, minZ, maxX, maxY, maxZ]`. */
export type DerivedBounds = readonly [number, number, number, number, number, number];

export interface DerivedLayer {
  readonly id: string;
  readonly type: DerivedLayerType;
  readonly name: string;
  /** The scan layer ids this was derived from (change layers carry two). */
  readonly sourceScanIds: readonly string[];
  /** Bumped each time the layer is regenerated from its sources. */
  readonly generation: number;
  /** The scientific record / receipt digest that produced it, when graded. */
  readonly provenanceDigest: string | null;
  /** Coverage honesty, mirroring the process model. */
  readonly coverage: 'full' | 'sampled' | 'resident-only' | 'unknown';
  /** Whether the deliverable is evidence-graded or exploratory. */
  readonly evidenceExploratory: boolean;
  readonly visible: boolean;
  /** 0..1. */
  readonly opacity: number;
  readonly style: Readonly<Record<string, string | number | boolean>>;
  readonly bounds: DerivedBounds | null;
}

export interface DerivedLayerInit {
  readonly id: string;
  readonly type: DerivedLayerType;
  readonly name: string;
  readonly sourceScanIds: readonly string[];
  readonly provenanceDigest?: string | null;
  readonly coverage?: DerivedLayer['coverage'];
  readonly evidenceExploratory?: boolean;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly style?: Record<string, string | number | boolean>;
  readonly bounds?: DerivedBounds | null;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function makeLayer(init: DerivedLayerInit, generation: number): DerivedLayer {
  return {
    id: init.id,
    type: init.type,
    name: init.name,
    sourceScanIds: [...init.sourceScanIds],
    generation,
    provenanceDigest: init.provenanceDigest ?? null,
    coverage: init.coverage ?? 'unknown',
    evidenceExploratory: init.evidenceExploratory ?? false,
    visible: init.visible ?? true,
    opacity: clamp01(init.opacity ?? 1),
    style: { ...(init.style ?? {}) },
    bounds: init.bounds ?? null,
  };
}

/**
 * A pure store of derived layers keyed by id, preserving insertion order. Adding
 * an existing id REPLACES it and bumps its generation (a regenerate), so a
 * downstream consumer can tell a fresh result from a stale one.
 */
export class DerivedLayerStore {
  private readonly _byId = new Map<string, DerivedLayer>();

  /** Add a new layer, or regenerate an existing one (generation bumps). */
  put(init: DerivedLayerInit): DerivedLayer {
    const prev = this._byId.get(init.id);
    const layer = makeLayer(init, prev ? prev.generation + 1 : 1);
    this._byId.set(init.id, layer);
    return layer;
  }

  get(id: string): DerivedLayer | undefined {
    return this._byId.get(id);
  }

  has(id: string): boolean {
    return this._byId.has(id);
  }

  remove(id: string): boolean {
    return this._byId.delete(id);
  }

  /** All layers, in insertion order. */
  list(): DerivedLayer[] {
    return [...this._byId.values()];
  }

  /** The layers derived from a given source scan (e.g. to drop them when it closes). */
  bySource(scanId: string): DerivedLayer[] {
    return this.list().filter((l) => l.sourceScanIds.includes(scanId));
  }

  setVisible(id: string, visible: boolean): DerivedLayer | undefined {
    return this._patch(id, { visible });
  }

  setOpacity(id: string, opacity: number): DerivedLayer | undefined {
    return this._patch(id, { opacity: clamp01(opacity) });
  }

  setStyle(id: string, style: Record<string, string | number | boolean>): DerivedLayer | undefined {
    const prev = this._byId.get(id);
    if (!prev) return undefined;
    return this._patch(id, { style: { ...prev.style, ...style } });
  }

  /** Show only `id`; hide the rest. Passing null clears the isolate (all visible). */
  solo(id: string | null): void {
    for (const [key, layer] of this._byId) {
      this._byId.set(key, { ...layer, visible: id === null ? true : key === id });
    }
  }

  private _patch(id: string, patch: Partial<DerivedLayer>): DerivedLayer | undefined {
    const prev = this._byId.get(id);
    if (!prev) return undefined;
    const next = { ...prev, ...patch };
    this._byId.set(id, next);
    return next;
  }
}
