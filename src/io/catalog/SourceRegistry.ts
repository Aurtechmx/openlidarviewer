/**
 * src/io/catalog/SourceRegistry.ts
 *
 * Tiny in-memory dispatcher across registered `CatalogProvider`s. The
 * registry stays deliberately dumb: providers register themselves, the
 * registry hands queries off to whichever providers claim coarse
 * coverage, and the caller picks among the results.
 *
 * The current release ships with exactly one provider (USGS 3DEP) so
 * the registry's job is largely shape-keeping. Keeping the surface thin
 * means new sources slot in without changing call sites in `main.ts`.
 */

import type {
  CatalogProvider,
  CatalogQueryOutcome,
  CatalogQueryResult,
  CatalogTile,
  LatLonBbox,
} from './types';

/** A registry entry — keeps the provider and its registration metadata. */
interface RegistryEntry {
  readonly provider: CatalogProvider;
  /** Order in which the provider was registered; used to break ties. */
  readonly registrationOrder: number;
}

/** Outcome shape for a multi-provider query. */
export interface AggregatedQueryOutcome {
  /** True when *any* provider returned at least one tile. */
  readonly ok: boolean;
  /**
   * Per-provider outcomes keyed by provider id. Always present so the
   * UI can render per-provider error messages alongside the merged
   * tile list (e.g. "USGS 3DEP: no coverage; OpenTopography: timeout").
   */
  readonly byProvider: ReadonlyMap<string, CatalogQueryOutcome>;
  /** Merged tile list across all providers that returned `ok: true`. */
  readonly tiles: readonly CatalogTile[];
  /** Sum of `estimatedBytes` across providers that reported one. */
  readonly estimatedBytes?: number;
}

/**
 * A SourceRegistry is the central directory of catalog providers. It
 * owns nothing about networking — its only job is to fan a bbox query
 * out across the registered providers in parallel and surface the
 * combined result.
 */
export class SourceRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private nextOrder = 0;

  /**
   * Register a provider. Re-registering an id replaces the previous
   * entry — the registry stays a Map, not a multimap.
   */
  register(provider: CatalogProvider): void {
    this.entries.set(provider.id, {
      provider,
      registrationOrder: this.nextOrder++,
    });
  }

  /** True when a provider with this id is registered. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Retrieve a single provider by id, or undefined when none is registered. */
  get(id: string): CatalogProvider | undefined {
    return this.entries.get(id)?.provider;
  }

  /**
   * List every registered provider in registration order. The UI uses
   * this for the source-picker.
   */
  list(): readonly CatalogProvider[] {
    return Array.from(this.entries.values())
      .sort((a, b) => a.registrationOrder - b.registrationOrder)
      .map((entry) => entry.provider);
  }

  /**
   * Providers whose `coarseCoverage` claims the bbox. This is the fast
   * pre-filter — used by the source-picker UI to hide irrelevant
   * providers globally without an HTTP round-trip.
   */
  providersFor(bbox: LatLonBbox): readonly CatalogProvider[] {
    return this.list().filter((provider) => provider.coarseCoverage(bbox));
  }

  /**
   * Fan a bbox query out across every provider that claims coarse
   * coverage. Providers run in parallel; their per-provider failures
   * never block the merged result.
   *
   * The returned `tiles` array preserves provider registration order
   * (so USGS appears before OpenTopography when both are registered),
   * not provider response time.
   */
  async query(
    bbox: LatLonBbox,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AggregatedQueryOutcome> {
    const candidates = this.list().filter((provider) =>
      provider.coarseCoverage(bbox),
    );

    if (candidates.length === 0) {
      return {
        ok: false,
        byProvider: new Map(),
        tiles: [],
      };
    }

    // Run providers in parallel; each provider is responsible for its
    // own timeout budget + error mapping. Settle (not all) so a single
    // slow provider can't sink the others.
    const settled = await Promise.allSettled(
      candidates.map((provider) => provider.query(bbox, options)),
    );

    const byProvider = new Map<string, CatalogQueryOutcome>();
    const tiles: CatalogTile[] = [];
    let estimatedBytes = 0;
    let sawEstimate = false;
    let anyOk = false;

    settled.forEach((settled, index) => {
      const provider = candidates[index];
      if (!provider) return;

      if (settled.status === 'rejected') {
        // A `rejected` promise here means the provider threw outside
        // its own typed-error handling — surface it as 'unknown' so
        // the UI never has to handle native Errors.
        const message =
          settled.reason instanceof Error
            ? settled.reason.message
            : 'Unknown catalog error.';
        byProvider.set(provider.id, {
          ok: false,
          error: { code: 'unknown', message },
        });
        return;
      }

      const outcome = settled.value;
      byProvider.set(provider.id, outcome);

      if (outcome.ok) {
        anyOk = true;
        tiles.push(...outcome.result.tiles);
        if (typeof outcome.result.estimatedBytes === 'number') {
          estimatedBytes += outcome.result.estimatedBytes;
          sawEstimate = true;
        }
      }
    });

    return {
      ok: anyOk,
      byProvider,
      tiles,
      estimatedBytes: sawEstimate ? estimatedBytes : undefined,
    };
  }
}

/**
 * Convenience: pull tiles into a flat `CatalogQueryResult` (the
 * single-provider shape) for call-sites that don't care which provider
 * served each tile.
 */
export function flattenAggregated(
  outcome: AggregatedQueryOutcome,
): CatalogQueryResult {
  return {
    tiles: outcome.tiles,
    estimatedBytes: outcome.estimatedBytes,
  };
}
