/**
 * frameGateProperties.test.ts — invariants of the spatial-frame gates.
 *
 * These gates decide whether coordinates from different sources may be
 * combined, so a defect in them does not crash: it produces a plausible number
 * from an unfounded merge. Three of the defects found in the last review round
 * were in gate code written the round before, and one repeated a bug fixed the
 * same day — all three were *shapes* of error (a unit compared against the
 * wrong unit, a live value read where a source value was meant, a verdict that
 * moved with array order) rather than a specific wrong case someone thought to
 * write a test for.
 *
 * Example tests catch the case you imagined. These state the properties that
 * must hold for EVERY input, and hunt for the counterexample themselves.
 *
 * No property-testing dependency: this package is heading for archival and a
 * new dev dependency lands in the SBOM. The generator below is a seeded PRNG,
 * so a failure prints the seed and is exactly reproducible — the property that
 * actually matters for a shrinking-free harness.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyLayerCompatibility,
  participatesInSharedAnalysis,
  alignsVertically,
  alignsHorizontally,
  verticalReferenceKey,
  type CompatibilityInput,
  type LayerCompatibility,
} from '../src/model/layerCompatibility';
import { integrableClouds, streamingMayCombine } from '../src/render/integrableClouds';
import { PointCloud } from '../src/model/PointCloud';
import { createProjectFrame, layerTransform } from '../src/geo/ProjectSpatialFrame';

// ── a tiny reproducible generator ──────────────────────────────────────────
/** mulberry32 — small, fast, and deterministic from a 32-bit seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run `check` over `runs` generated cases. On failure the seed is reported,
 * so the exact case can be replayed rather than re-guessed.
 */
function forAll<T>(
  name: string,
  gen: (r: () => number) => T,
  check: (value: T) => void,
  runs = 200,
): void {
  for (let i = 0; i < runs; i++) {
    const seed = 0x5eed + i;
    const value = gen(rng(seed));
    try {
      check(value);
    } catch (err) {
      throw new Error(
        `${name} failed at seed ${seed}\ninput: ${JSON.stringify(value)}\n${(err as Error).message}`,
      );
    }
  }
}

const EPSGS = [undefined, 32612, 32613, 25829, 2056, 4326];
const VERTICALS: Array<string | null> = [null, 'EPSG:5703', 'EPSG:4979', 'NAVD88'];
const NAMES = [undefined, 'UTM 12N', 'Local grid'];

function genLayers(r: () => number): CompatibilityInput[] {
  const n = 1 + Math.floor(r() * 5);
  const out: CompatibilityInput[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `L${i}`,
      epsg: EPSGS[Math.floor(r() * EPSGS.length)],
      crsName: NAMES[Math.floor(r() * NAMES.length)],
      verticalDatum: VERTICALS[Math.floor(r() * VERTICALS.length)],
    });
  }
  return out;
}

const shuffle = <T>(xs: readonly T[], r: () => number): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const asObject = (m: Map<string, LayerCompatibility>) =>
  Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));

describe('classifyLayerCompatibility — invariants', () => {
  it('is total: every input gets exactly one verdict', () => {
    forAll('totality', genLayers, (layers) => {
      const m = classifyLayerCompatibility(layers);
      expect(m.size).toBe(new Set(layers.map((l) => l.id)).size);
      for (const l of layers) expect(m.get(l.id)).toBeDefined();
    });
  });

  it('is deterministic: the same set classifies the same way twice', () => {
    forAll('determinism', genLayers, (layers) => {
      expect(asObject(classifyLayerCompatibility(layers)))
        .toEqual(asObject(classifyLayerCompatibility(layers)));
    });
  });

  it('is order-independent: no verdict depends on array position', () => {
    // The exact defect a reviewer reproduced: the same three files classified
    // differently depending on which was listed first.
    forAll('order independence', (r) => ({ layers: genLayers(r), r }), ({ layers, r }) => {
      const base = asObject(classifyLayerCompatibility(layers));
      for (let k = 0; k < 4; k++) {
        expect(asObject(classifyLayerCompatibility(shuffle(layers, r)))).toEqual(base);
      }
    });
  });

  it('never verifies a layer that declared no CRS', () => {
    forAll('undeclared is never verified', genLayers, (layers) => {
      if (layers.length < 2) return;
      const m = classifyLayerCompatibility(layers);
      for (const l of layers) {
        const declared = l.epsg !== undefined || (l.crsName?.trim() ?? '') !== '';
        if (!declared) expect(m.get(l.id)).toBe('unknown');
      }
    });
  });

  it('never verifies a layer with no declared vertical datum', () => {
    // Undeclared is the absence of a claim, not agreement.
    forAll('undeclared vertical is never verified', genLayers, (layers) => {
      if (layers.length < 2) return;
      const m = classifyLayerCompatibility(layers);
      for (const l of layers) {
        if (!l.verticalDatum) expect(m.get(l.id)).not.toBe('verified');
      }
    });
  });

  it('agrees with itself: verified layers all share one vertical datum', () => {
    forAll('verified set is vertically unanimous', genLayers, (layers) => {
      const m = classifyLayerCompatibility(layers);
      // Compared on IDENTITY, not spelling: "NAVD88" and "EPSG:5703" are one
      // datum reached by two resolution paths, and both may verify.
      const verticals = layers
        .filter((l) => m.get(l.id) === 'verified')
        .map((l) => verticalReferenceKey(l));
      if (verticals.length > 1) {
        expect(new Set(verticals).size).toBe(1);
      }
    });
  });

  it('a lone layer is always verified, whatever it declares', () => {
    forAll('single layer', (r) => genLayers(r)[0], (one) => {
      expect(classifyLayerCompatibility([one]).get(one.id)).toBe('verified');
    });
  });

  it('the permission helpers form a strict ladder', () => {
    // Anything that may be merged may also be aligned; anything aligned in Z
    // is aligned in X/Y. A gate that inverted would be caught here.
    const ALL: LayerCompatibility[] = ['verified', 'horizontal-only', 'unknown', 'incompatible'];
    for (const c of ALL) {
      if (participatesInSharedAnalysis(c)) expect(alignsVertically(c)).toBe(true);
      if (alignsVertically(c)) expect(alignsHorizontally(c)).toBe(true);
    }
  });
});

describe('integrableClouds — invariants', () => {
  type Entry = { mesh: { visible: boolean }; locked?: boolean; compatibility?: LayerCompatibility };
  const STATES: LayerCompatibility[] = ['verified', 'horizontal-only', 'unknown', 'incompatible'];

  const genEntries = (r: () => number): Entry[] => {
    const n = Math.floor(r() * 6);
    const out: Entry[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        mesh: { visible: r() > 0.25 },
        locked: r() > 0.8,
        compatibility: r() > 0.15 ? STATES[Math.floor(r() * STATES.length)] : undefined,
      });
    }
    return out;
  };

  it('only ever returns entries the user is working with', () => {
    forAll('subset of visible+unlocked', genEntries, (entries) => {
      for (const e of integrableClouds(entries)) {
        expect(e.mesh.visible).toBe(true);
        expect(e.locked).not.toBe(true);
      }
    });
  });

  it('merges only verified layers once more than one is available', () => {
    forAll('merge requires proof', genEntries, (entries) => {
      const available = entries.filter((e) => e.mesh.visible && e.locked !== true);
      const result = integrableClouds(entries);
      if (available.length > 1) {
        for (const e of result) expect(e.compatibility ?? 'verified').toBe('verified');
      }
    });
  });

  it('never drops a lone available layer, whatever its state', () => {
    // Analysing one layer by itself combines nothing, so there is nothing to
    // prove — gating it made the tool refuse to measure a single file.
    forAll('single-layer carve-out', genEntries, (entries) => {
      const available = entries.filter((e) => e.mesh.visible && e.locked !== true);
      if (available.length === 1) expect(integrableClouds(entries)).toHaveLength(1);
    });
  });

  it('is idempotent: filtering an already-filtered set changes nothing', () => {
    forAll('idempotence', genEntries, (entries) => {
      const once = integrableClouds(entries);
      expect(integrableClouds(once)).toEqual(once);
    });
  });

  it('streaming clears the same bar static layers do', () => {
    // Both halves of the bar: proven compatibility AND an actual mount. A CRS
    // match says the two frames are the same KIND; only a mount says the two
    // local arrays are in the same SPACE.
    forAll('streaming parity', (r) => ({
      staticCount: Math.floor(r() * 4),
      state: STATES[Math.floor(r() * STATES.length)],
      mounted: r() > 0.5,
    }), ({ staticCount, state, mounted }) => {
      const allowed = streamingMayCombine(staticCount, state, mounted);
      if (staticCount === 0) expect(allowed).toBe(true);
      else expect(allowed).toBe(participatesInSharedAnalysis(state) && mounted);
    });
  });

  it('never merges a stream with static layers while nothing is mounted', () => {
    // The shipped configuration: mounting is off, so this must hold for every
    // compatibility state and every number of static layers.
    forAll('unmounted streams never merge', (r) => ({
      staticCount: 1 + Math.floor(r() * 5),
      state: STATES[Math.floor(r() * STATES.length)],
    }), ({ staticCount, state }) => {
      expect(streamingMayCombine(staticCount, state, false)).toBe(false);
    });
  });
});

describe('PointCloud frame transitions — invariants', () => {
  const genCloud = (r: () => number) => {
    const n = 1 + Math.floor(r() * 8);
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < positions.length; i++) positions[i] = (r() - 0.5) * 200;
    const origin: [number, number, number] = [
      Math.floor(r() * 800000), Math.floor(r() * 5000000), Math.floor(r() * 500),
    ];
    const target: [number, number, number] = [
      origin[0] - Math.floor(r() * 2000),
      origin[1] - Math.floor(r() * 2000),
      origin[2] - Math.floor(r() * 50),
    ];
    return { positions, origin, target };
  };

  const make = (positions: Float32Array, origin: [number, number, number]) =>
    new PointCloud({ positions, origin: [...origin], sourceFormat: 'las', name: 'p.las' });

  it('a placement never moves a point in the world', () => {
    // The property the destructive rebase could only hold to within a Float32
    // step now holds to Float64 addition: lifting a project-local coordinate
    // back through the project origin gives the world coordinate, for every
    // cloud and every placement. `target` plays the project origin.
    forAll('world invariance', genCloud, ({ positions, origin, target }) => {
      const c = make(Float32Array.from(positions), origin);
      const t = layerTransform(createProjectFrame(target), [...c.sourceOrigin]);
      const w: [number, number, number] = [0, 0, 0];
      const p: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < c.pointCount; i++) {
        c.worldXYZ(i, w);
        c.projectXYZ(i, t, p);
        for (let a = 0; a < 3; a++) {
          expect(p[a] + target[a]).toBeCloseTo(w[a], 9);
        }
      }
    });
  });

  it('the source origin and positions survive any sequence of placements', () => {
    // Placement is set, cleared and re-set as data ABOUT the layer; the cloud
    // itself must come through any such cycle untouched — that is what makes
    // mount and unmount exact inverses.
    forAll('source origin immutability', genCloud, ({ positions, origin, target }) => {
      const c = make(Float32Array.from(positions), origin);
      const originBefore = [...c.sourceOrigin];
      const positionsBefore = c.positions.slice();
      const mounted = layerTransform(createProjectFrame(target), [...c.sourceOrigin]);
      const identity = layerTransform(createProjectFrame([...c.sourceOrigin]), [...c.sourceOrigin]);
      for (const t of [mounted, identity, mounted]) {
        for (let i = 0; i < c.pointCount; i++) c.projectXYZ(i, t);
      }
      expect([...c.sourceOrigin]).toEqual(originBefore);
      expect([...c.origin]).toEqual(originBefore);
      expect(originBefore).toEqual(origin);
      expect(c.positions).toEqual(positionsBefore);
    });
  });

  it('the reported quantum is non-negative and grows with distance', () => {
    forAll('quantum monotonicity', genCloud, ({ positions, origin }) => {
      const c = make(Float32Array.from(positions), origin);
      const near = c.rebaseQuantum([origin[0], origin[1], origin[2]]);
      const far = c.rebaseQuantum([origin[0] - 500000, origin[1], origin[2]]);
      // Same invariant, now held per axis group: never negative, and moving
      // 500 km in X never makes either reported cost smaller.
      expect(near.horizontal).toBeGreaterThanOrEqual(0);
      expect(near.vertical).toBeGreaterThanOrEqual(0);
      expect(far.horizontal).toBeGreaterThanOrEqual(near.horizontal);
      expect(far.vertical).toBeGreaterThanOrEqual(near.vertical);
    });
  });
});
