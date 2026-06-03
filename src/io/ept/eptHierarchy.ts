/**
 * eptHierarchy.ts
 *
 * Parse + traverse EPT hierarchy files. The hierarchy lives in
 * `ept-hierarchy/D-X-Y-Z.json` files at the dataset root. Each file is a
 * JSON object keyed by the `"D-X-Y-Z"` address string, with values that
 * are either:
 *
 *   • a non-negative integer — the point count in that node's tile; OR
 *   • `-1` — a "link" entry: this subtree continues in another file
 *     named `ept-hierarchy/D-X-Y-Z.json` for the linked key.
 *
 * The root hierarchy file is always `0-0-0-0.json`. A small dataset may
 * have everything in that one file; a 100M+ dataset will have hundreds of
 * linked hierarchy files reached on-demand as the scheduler refines.
 *
 * Reference: https://entwine.io/en/latest/entwine-point-tile.html#hierarchy
 *
 * Pure parser — no I/O, no three.js. The streaming-source class owns the
 * fetch + cache; this module is just JSON in, hierarchy out.
 */

import { eptStringToKey } from './eptTypes';
import type { EptHierarchyMap, EptKey } from './eptTypes';

/** A parsed entry from a hierarchy file. */
export interface EptHierarchyEntry {
  readonly key: EptKey;
  /**
   * Point count in this node's tile, or -1 to indicate the subtree is
   * stored in a separate hierarchy file (the caller follows the link by
   * fetching `ept-hierarchy/D-X-Y-Z.json`).
   */
  readonly value: number;
}

/** The result of parsing one hierarchy file. */
export interface ParsedHierarchyFile {
  /** Every entry in the file, in insertion order. */
  readonly entries: readonly EptHierarchyEntry[];
  /** Subset of entries whose value is -1 — the links to follow. */
  readonly links: readonly EptHierarchyEntry[];
  /** Subset of entries whose value is > 0 — the actual node point counts. */
  readonly nodes: readonly EptHierarchyEntry[];
  /** Sum of node point counts in THIS file (excludes link references). */
  readonly totalPoints: number;
}

/**
 * Parse the body of one EPT hierarchy JSON file. Returns the entries
 * partitioned into `nodes` (point counts) and `links` (subtree pointers).
 *
 * Throws on malformed input (non-object root, non-numeric values, bad
 * address strings). Throwing here is fine because the streaming-source
 * class wraps the call in its retry/error-typing layer; the caller never
 * sees the raw throw.
 */
export function parseHierarchyFile(text: string): ParsedHierarchyFile {
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('EPT hierarchy file root must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const entries: EptHierarchyEntry[] = [];
  const links: EptHierarchyEntry[] = [];
  const nodes: EptHierarchyEntry[] = [];
  let totalPoints = 0;

  for (const [keyStr, val] of Object.entries(obj)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new Error(`EPT hierarchy entry "${keyStr}" has non-numeric value.`);
    }
    const key = eptStringToKey(keyStr);
    if (!key) {
      throw new Error(`EPT hierarchy entry "${keyStr}" is not a valid D-X-Y-Z address.`);
    }
    const entry: EptHierarchyEntry = { key, value: val };
    entries.push(entry);
    if (val === -1) {
      links.push(entry);
    } else if (val > 0) {
      nodes.push(entry);
      totalPoints += val;
    }
    // value === 0 is permitted (empty leaf node); we just don't count it.
  }

  return { entries, links, nodes, totalPoints };
}

/**
 * Walk a hierarchy map (the typed shape from {@link EptHierarchyMap}) and
 * produce the same partition. Convenience for tests that have the map
 * already and don't want to JSON.stringify just to call the parser.
 */
export function partitionHierarchyMap(map: EptHierarchyMap): ParsedHierarchyFile {
  return parseHierarchyFile(JSON.stringify(map));
}

/**
 * The 8 child keys of an EPT octree node at depth `d`. EPT uses simple
 * doubling: a parent at `(d, x, y, z)` has children at
 * `(d+1, 2x[+0..1], 2y[+0..1], 2z[+0..1])`.
 */
export function eptChildKeys(parent: EptKey): readonly EptKey[] {
  const d = parent.d + 1;
  const x2 = parent.x * 2;
  const y2 = parent.y * 2;
  const z2 = parent.z * 2;
  return [
    { d, x: x2,     y: y2,     z: z2     },
    { d, x: x2 + 1, y: y2,     z: z2     },
    { d, x: x2,     y: y2 + 1, z: z2     },
    { d, x: x2 + 1, y: y2 + 1, z: z2     },
    { d, x: x2,     y: y2,     z: z2 + 1 },
    { d, x: x2 + 1, y: y2,     z: z2 + 1 },
    { d, x: x2,     y: y2 + 1, z: z2 + 1 },
    { d, x: x2 + 1, y: y2 + 1, z: z2 + 1 },
  ];
}
