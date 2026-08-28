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
 * Maximum number of entries one hierarchy page may declare.
 *
 * The transport already caps a page by bytes, but a densely packed page (short
 * keys, small counts) reaches a high entry count well below that byte ceiling,
 * and each entry becomes a parsed object key plus an {@link EptHierarchyEntry}
 * in up to three arrays. Bound the count directly so the parse heap stays
 * predictable regardless of how tightly the JSON packs. A real Entwine page
 * splits at a hierarchy step and holds far fewer than this; the committed
 * reference fixture holds one. This is a defense-in-depth ceiling, not a tight
 * fit.
 */
export const MAX_HIERARCHY_ENTRIES = 2_000_000;

/**
 * Parse the body of one EPT hierarchy JSON file. Returns the entries
 * partitioned into `nodes` (point counts) and `links` (subtree pointers).
 *
 * `maxEntries` bounds how many entries one page may declare, defaulting to
 * {@link MAX_HIERARCHY_ENTRIES}; a page over it is refused before the
 * partitioned arrays are built. Exposed as a parameter so the bound is testable
 * without materialising millions of entries.
 *
 * Throws on malformed input (non-object root, non-numeric values, bad
 * address strings) and on a page over the entry ceiling. Throwing here is fine
 * because the streaming-source class wraps the call in its retry/error-typing
 * layer; the caller never sees the raw throw.
 */
export function parseHierarchyFile(
  text: string,
  maxEntries: number = MAX_HIERARCHY_ENTRIES,
): ParsedHierarchyFile {
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('EPT hierarchy file root must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  // Bound the entry count BEFORE building the partitioned arrays. A page above
  // the ceiling is refused rather than expanded into three parallel arrays of
  // entry objects — the byte cap in the transport is the outer guard, this is
  // the inner one for a densely packed page that stays under it.
  const declaredEntries = Object.keys(obj).length;
  if (declaredEntries > maxEntries) {
    throw new Error(
      `EPT hierarchy page declares ${declaredEntries} entries, over the ` +
        `${maxEntries} maximum; refusing to parse it.`,
    );
  }
  const entries: EptHierarchyEntry[] = [];
  const links: EptHierarchyEntry[] = [];
  const nodes: EptHierarchyEntry[] = [];
  let totalPoints = 0;

  for (const [keyStr, val] of Object.entries(obj)) {
    // A hierarchy value is either the -1 link sentinel or a whole point count.
    // Accepting any finite number let 0.5 be counted as a node and -2 fall
    // through both branches, silently ignored rather than refused.
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new Error(`EPT hierarchy entry "${keyStr}" has non-numeric value.`);
    }
    // A hierarchy value is either the -1 link sentinel or a whole point count.
    // Accepting any finite number let 0.5 be counted as a node and -2 fall
    // through both branches, silently ignored rather than refused.
    if (!(val === -1 || (Number.isSafeInteger(val) && val >= 0))) {
      throw new Error(
        `EPT hierarchy entry "${keyStr}" must be -1 or a non-negative whole point count, got ${String(val)}.`,
      );
    }
    const key = eptStringToKey(keyStr);
    if (!key) {
      throw new Error(`EPT hierarchy entry "${keyStr}" is not a valid D-X-Y-Z address.`);
    }
    // At depth d each axis has 2**d cells, so an index at or above that names
    // no node in this tree however well-formed the string was.
    const span = 2 ** key.d;
    if (key.x >= span || key.y >= span || key.z >= span) {
      throw new Error(`EPT hierarchy entry "${keyStr}" is outside the ${span} cells depth ${key.d} has.`);
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
