/**
 * catalogRegistry.test.ts
 *
 * Contract tests for the SourceRegistry — registration, fan-out across
 * providers, error mapping, and the coverage pre-filter. Pure data
 * surface, no DOM, no network.
 */

import { describe, it, expect } from 'vitest';
import {
  SourceRegistry,
  type CatalogProvider,
  type CatalogQueryOutcome,
  type LatLonBbox,
  flattenAggregated,
} from '../src/io/catalog';

function fakeProvider(
  id: string,
  outcome: CatalogQueryOutcome,
  coverage: (bbox: LatLonBbox) => boolean = () => true,
): CatalogProvider {
  return {
    id,
    label: `Fake ${id}`,
    description: `A fake provider for tests (${id}).`,
    attribution: `Fake ${id} attribution`,
    license: 'Test license',
    coarseCoverage: coverage,
    async query() {
      return outcome;
    },
  };
}

const SAMPLE_BBOX: LatLonBbox = [-100, 40, -99, 41];

describe('SourceRegistry — registration', () => {
  it('registers and retrieves providers', () => {
    const registry = new SourceRegistry();
    const okProvider = fakeProvider('a', {
      ok: true,
      result: { tiles: [] },
    });
    registry.register(okProvider);
    expect(registry.has('a')).toBe(true);
    expect(registry.get('a')).toBe(okProvider);
    expect(registry.list().map((p) => p.id)).toEqual(['a']);
  });

  it('preserves registration order', () => {
    const registry = new SourceRegistry();
    registry.register(fakeProvider('a', { ok: true, result: { tiles: [] } }));
    registry.register(fakeProvider('b', { ok: true, result: { tiles: [] } }));
    registry.register(fakeProvider('c', { ok: true, result: { tiles: [] } }));
    expect(registry.list().map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('replaces same-id registrations idempotently', () => {
    const registry = new SourceRegistry();
    registry.register(fakeProvider('a', { ok: true, result: { tiles: [] } }));
    const second = fakeProvider('a', {
      ok: false,
      error: { code: 'unknown', message: 'replaced' },
    });
    registry.register(second);
    expect(registry.get('a')).toBe(second);
    expect(registry.list().length).toBe(1);
  });
});

describe('SourceRegistry — coarse coverage', () => {
  it('filters providers without coverage from list-by-bbox', () => {
    const registry = new SourceRegistry();
    registry.register(
      fakeProvider('a', { ok: true, result: { tiles: [] } }, () => true),
    );
    registry.register(
      fakeProvider('b', { ok: true, result: { tiles: [] } }, () => false),
    );
    expect(registry.providersFor(SAMPLE_BBOX).map((p) => p.id)).toEqual(['a']);
  });
});

describe('SourceRegistry — query fan-out', () => {
  it('returns ok=false with empty map when no provider covers the bbox', async () => {
    const registry = new SourceRegistry();
    registry.register(
      fakeProvider('a', { ok: true, result: { tiles: [] } }, () => false),
    );
    const outcome = await registry.query(SAMPLE_BBOX);
    expect(outcome.ok).toBe(false);
    expect(outcome.byProvider.size).toBe(0);
    expect(outcome.tiles.length).toBe(0);
  });

  it('aggregates tiles across providers', async () => {
    const registry = new SourceRegistry();
    registry.register(
      fakeProvider('a', {
        ok: true,
        result: {
          tiles: [
            {
              id: 't1',
              displayName: 'Tile 1',
              format: 'copc',
              streamUrl: 'https://example.com/a.copc.laz',
              bbox: SAMPLE_BBOX,
              attribution: 'X',
              license: 'Y',
            },
          ],
          estimatedBytes: 100,
        },
      }),
    );
    registry.register(
      fakeProvider('b', {
        ok: true,
        result: {
          tiles: [
            {
              id: 't2',
              displayName: 'Tile 2',
              format: 'copc',
              streamUrl: 'https://example.com/b.copc.laz',
              bbox: SAMPLE_BBOX,
              attribution: 'X',
              license: 'Y',
            },
          ],
          estimatedBytes: 200,
        },
      }),
    );

    const outcome = await registry.query(SAMPLE_BBOX);
    expect(outcome.ok).toBe(true);
    expect(outcome.tiles.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(outcome.estimatedBytes).toBe(300);
    expect(outcome.byProvider.size).toBe(2);
  });

  it('keeps successful tiles even when a peer provider errors', async () => {
    const registry = new SourceRegistry();
    registry.register(
      fakeProvider('a', {
        ok: true,
        result: {
          tiles: [
            {
              id: 't1',
              displayName: 'Tile 1',
              format: 'copc',
              streamUrl: 'https://example.com/a.copc.laz',
              bbox: SAMPLE_BBOX,
              attribution: 'X',
              license: 'Y',
            },
          ],
        },
      }),
    );
    registry.register(
      fakeProvider('b', {
        ok: false,
        error: { code: 'timeout', message: 'b timed out' },
      }),
    );
    const outcome = await registry.query(SAMPLE_BBOX);
    expect(outcome.ok).toBe(true);
    expect(outcome.tiles.length).toBe(1);
    expect(outcome.byProvider.get('b')?.ok).toBe(false);
  });

  it('maps a thrown error into a typed `unknown` outcome', async () => {
    const registry = new SourceRegistry();
    const thrower: CatalogProvider = {
      id: 'throws',
      label: 'Thrower',
      description: 'throws synchronously',
      attribution: 'X',
      license: 'Y',
      coarseCoverage: () => true,
      async query() {
        throw new Error('boom');
      },
    };
    registry.register(thrower);
    const outcome = await registry.query(SAMPLE_BBOX);
    expect(outcome.ok).toBe(false);
    const errorOutcome = outcome.byProvider.get('throws');
    expect(errorOutcome?.ok).toBe(false);
    if (errorOutcome && !errorOutcome.ok) {
      expect(errorOutcome.error.code).toBe('unknown');
      expect(errorOutcome.error.message).toContain('boom');
    }
  });

  it('omits estimatedBytes when no provider reports one', async () => {
    const registry = new SourceRegistry();
    registry.register(
      fakeProvider('a', {
        ok: true,
        result: {
          tiles: [
            {
              id: 't1',
              displayName: 'Tile 1',
              format: 'copc',
              streamUrl: 'https://example.com/a.copc.laz',
              bbox: SAMPLE_BBOX,
              attribution: 'X',
              license: 'Y',
            },
          ],
        },
      }),
    );
    const outcome = await registry.query(SAMPLE_BBOX);
    expect(outcome.estimatedBytes).toBeUndefined();
  });
});

describe('flattenAggregated', () => {
  it('preserves tiles and estimatedBytes', () => {
    const flat = flattenAggregated({
      ok: true,
      byProvider: new Map(),
      tiles: [
        {
          id: 't1',
          displayName: 'Tile 1',
          format: 'copc',
          streamUrl: 'https://example.com/a.copc.laz',
          bbox: SAMPLE_BBOX,
          attribution: 'X',
          license: 'Y',
        },
      ],
      estimatedBytes: 42,
    });
    expect(flat.tiles.length).toBe(1);
    expect(flat.estimatedBytes).toBe(42);
  });
});
