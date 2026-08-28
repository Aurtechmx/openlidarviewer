/**
 * eptPredecodeAdmission.test.ts
 *
 * Covers two EPT hardening findings landed alongside the pre-decode header gate:
 *
 *   • Finding 8 — the EPT hierarchy JSON cap. A page over the entry-count
 *     ceiling is refused by `parseHierarchyFile` before the partitioned arrays
 *     are built. The byte ceiling itself lives in `eptTransport` and is exported
 *     for verification through the bounded-read path in its own suite; here we
 *     lock the parser's entry-count bound.
 *   • Finding 9 — `StreamingNodeStore.add()`. A repeated id with an identical
 *     record is idempotent; a repeated id with a conflicting record throws
 *     HIERARCHY_CONFLICT instead of silently keeping the first-seen figure.
 */

import { describe, it, expect } from 'vitest';
import { parseHierarchyFile, MAX_HIERARCHY_ENTRIES } from '../src/io/ept/eptHierarchy';
import { StreamingNodeStore } from '../src/render/streaming/StreamingNodeStore';
import type { StreamingNodeRecord } from '../src/io/copc/copcTypes';

function rec(overrides: Partial<StreamingNodeRecord> = {}): StreamingNodeRecord {
  return {
    id: '1-0-0-0',
    key: { depth: 1, x: 0, y: 0, z: 0 },
    depth: 1,
    bounds: [0, 0, 0, 1, 1, 1],
    pointCount: 100,
    byteOffset: 0,
    byteSize: 0,
    spacing: 1,
    ...overrides,
  };
}

describe('Finding 8 — EPT hierarchy entry-count ceiling', () => {
  it('accepts a normal single-node hierarchy page', () => {
    const parsed = parseHierarchyFile(JSON.stringify({ '0-0-0-0': 256 }));
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.totalPoints).toBe(256);
  });

  it('exposes a finite production entry ceiling', () => {
    expect(MAX_HIERARCHY_ENTRIES).toBe(2_000_000);
  });

  it('refuses a page declaring more entries than the ceiling', () => {
    // A page of 4 valid leaf entries, refused against an injected ceiling of 3.
    // The bound is the production ceiling by default; passing a small one here
    // exercises the exact refusal path without materialising millions of keys.
    const page = JSON.stringify({
      '1-0-0-0': 10,
      '1-1-0-0': 20,
      '1-0-1-0': 30,
      '1-1-1-0': 40,
    });
    expect(() => parseHierarchyFile(page, 3)).toThrow(
      /declares 4 entries, over the 3 maximum/,
    );
    // The same page is accepted under the production ceiling.
    expect(parseHierarchyFile(page).nodes).toHaveLength(4);
  });
});

describe('Finding 9 — StreamingNodeStore.add() conflict detection', () => {
  it('is idempotent for a repeated id with an identical record', () => {
    const store = new StreamingNodeStore();
    const first = store.add(rec());
    const second = store.add(rec());
    expect(second).toBe(first);
    expect(store.size).toBe(1);
  });

  it('throws HIERARCHY_CONFLICT for a repeated id with a different pointCount', () => {
    const store = new StreamingNodeStore();
    store.add(rec({ pointCount: 100 }));
    expect(() => store.add(rec({ pointCount: 5_000_000 }))).toThrow(
      /HIERARCHY_CONFLICT/,
    );
  });

  it('throws for a repeated id with different bounds', () => {
    const store = new StreamingNodeStore();
    store.add(rec());
    expect(() => store.add(rec({ bounds: [0, 0, 0, 2, 2, 2] }))).toThrow(
      /HIERARCHY_CONFLICT/,
    );
  });

  it('throws for a repeated id with a different tile byte location', () => {
    const store = new StreamingNodeStore();
    store.add(rec({ byteOffset: 0, byteSize: 10 }));
    expect(() => store.add(rec({ byteOffset: 999, byteSize: 10 }))).toThrow(
      /HIERARCHY_CONFLICT/,
    );
  });
});
