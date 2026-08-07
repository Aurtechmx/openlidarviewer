/**
 * layerIdentityService.ts — the running app's one owner of layer identity.
 *
 * The model in `model/layerIdentity.ts` already knows how to mint and remember a
 * stable, name-independent `layerId` from a scan's source fingerprint, and
 * `model/workOwnership.ts` already knows how to turn that id into the owner a
 * measurement or annotation carries. Neither had a caller: ownership still
 * resolved by whatever cloud happened to be active, i.e. by filename. This
 * service is that missing caller — the single place the app binds a loaded
 * cloud's viewer id to its stable identity, and the single place it decides the
 * owner stamped on freshly placed work.
 *
 * Three deliberate boundaries:
 *
 *   • It keys on SOURCE facts, never on display-sampled values. The load path
 *     hands it `scanFactsFromStatic` (declared point count + tolerant extents +
 *     CRS), which is source-stable, so the same file loaded at two strides — a
 *     phone's tight budget vs a desktop's full one — resolves to the SAME id.
 *
 *   • It fails closed. A fingerprint that distinguishes nothing but a filename
 *     collides between genuinely different scans, so it is refused a binding
 *     (`hasDistinguishingSourceFacts`); the layer still loads and works, it
 *     simply carries no proven identity this session. And the active layer with
 *     no binding yields no owner rather than a guessed one.
 *
 *   • It preserves the single-layer byte shape. With one layer open the
 *     session's one origin already IS that layer's frame, so an owner records
 *     nothing the single-frame reading does not already carry — and emitting one
 *     would break the byte-identical round trip the v8 schema is built around.
 *     So `ownerForNewWork` returns nothing until a SECOND layer is present, and
 *     only then does new work begin naming which layer it belongs to.
 *
 * Pure app state — no DOM, no three.js, no viewer — so the binding and gating
 * rules are unit-tested in Node. The work stores it wires are reached only
 * through the tiny structural {@link OwnerStampable} seam, never the concrete
 * controllers.
 */

import {
  LayerIdentityRegistry,
  type LayerFingerprint,
  type LayerRecord,
} from '../model/layerIdentity';
import { hasDistinguishingSourceFacts, sourceLocalOwnership } from '../model/workOwnership';
import type { WorkOwnership } from '../model/workOwnership';

/**
 * The minimum a work store exposes for this service to stamp ownership onto the
 * items it creates. `MeasureController` and `AnnotationController` satisfy it
 * structurally, so this app service never depends on the render layer.
 */
export interface OwnerStampable {
  /** Install the provider consulted when a new measurement / annotation is created. */
  setOwnerProvider(provider: () => WorkOwnership | undefined): void;
}

export interface LayerIdentityServiceOptions {
  /** Override the id generator (tests inject a deterministic counter). */
  readonly generateId?: () => string;
}

export interface LayerIdentityService {
  /**
   * Bind a freshly loaded cloud's viewer id to its stable identity, resolved
   * through the registry on its SOURCE facts. Returns the record, or null when
   * the facts distinguish nothing but a filename (fail closed — no binding, so
   * the layer carries no proven identity rather than a colliding one).
   */
  bindOnLoad(
    viewerId: string,
    facts: LayerFingerprint,
    displayName: string,
  ): LayerRecord | null;
  /** The stable id bound to a viewer id, or null when none was bound. */
  stableIdFor(viewerId: string): string | null;
  /**
   * The owner to stamp on a newly created measurement / annotation, or
   * undefined to leave it unowned. Undefined for a single (or empty) scene —
   * the byte-identical case — and for an active layer with no proven identity.
   */
  ownerForNewWork(
    activeViewerId: string | null,
    layerCount: number,
  ): WorkOwnership | undefined;
  /**
   * Install the owner provider on each work store, ONCE. The provider reads the
   * active layer and the live layer count at call time (through the supplied
   * accessors), so it follows scan switches without being rewired on every load.
   */
  ensureStoresWired(
    stores: readonly OwnerStampable[],
    activeViewerId: () => string | null,
    layerCount: () => number,
  ): void;
}

export function createLayerIdentityService(
  options: LayerIdentityServiceOptions = {},
): LayerIdentityService {
  const registry = new LayerIdentityRegistry(
    options.generateId ? { generateId: options.generateId } : {},
  );
  /**
   * viewer id → stable record. The viewer mints monotonic, never-reused ids
   * (`cloud_${n++}`), so an entry left behind by a removed layer can never
   * mis-key a later one; the registry's own fingerprint memory is what recovers
   * a reopened scan's id, so nothing here needs to survive a close.
   */
  const byViewerId = new Map<string, LayerRecord>();
  let wired = false;

  const bindOnLoad = (
    viewerId: string,
    facts: LayerFingerprint,
    displayName: string,
  ): LayerRecord | null => {
    // A filename alone is not identity: two captures are routinely dropped
    // under one name, and their fingerprints would collide. Refuse the
    // binding — honour the same fail-closed rule the ownership resolver uses —
    // rather than hand out an id that cannot tell the scans apart.
    if (!hasDistinguishingSourceFacts(facts)) {
      byViewerId.delete(viewerId);
      return null;
    }
    const record = registry.resolve(facts, displayName);
    byViewerId.set(viewerId, record);
    return record;
  };

  const stableIdFor = (viewerId: string): string | null =>
    byViewerId.get(viewerId)?.layerId ?? null;

  const ownerForNewWork = (
    activeViewerId: string | null,
    layerCount: number,
  ): WorkOwnership | undefined => {
    // One layer (or none) keeps the pre-identity byte shape exactly: the
    // session's single origin already anchors this work, so naming an owner
    // adds nothing and would break the byte-identical round trip.
    if (layerCount <= 1 || activeViewerId === null) return undefined;
    const record = byViewerId.get(activeViewerId);
    // An active layer with no proven identity gets no owner rather than a
    // guessed one — a wrong owner moves saved work, a missing one does not.
    if (!record) return undefined;
    return sourceLocalOwnership(record.layerId);
  };

  const ensureStoresWired = (
    stores: readonly OwnerStampable[],
    activeViewerId: () => string | null,
    layerCount: () => number,
  ): void => {
    if (wired) return;
    wired = true;
    const provider = (): WorkOwnership | undefined =>
      ownerForNewWork(activeViewerId(), layerCount());
    for (const store of stores) store.setOwnerProvider(provider);
  };

  return { bindOnLoad, stableIdFor, ownerForNewWork, ensureStoresWired };
}
