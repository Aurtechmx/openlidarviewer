/**
 * profileRawFilter.test.ts
 *
 * The raw scatter's selection rules and the honesty of the descriptor that
 * reports them.
 *
 * The fixture mixes one classified source at slot 4 with one unclassified
 * source at slot 9, and the slots are non-contiguous and unequal to any point's
 * position in the section, so a source filter that matched the point index, or
 * the position of a slot in the request list, selects a different set. The
 * classified source carries class 0 as well as ground, vegetation, building,
 * noise and water, so "unclassified" and "class 0" are separable: a rule that
 * reads a missing classification as 0 changes which points survive.
 *
 * Expected counts are written out from the fixture rather than derived from the
 * module, so a descriptor that reports the module's own arithmetic back to
 * itself cannot pass.
 */
import { describe, it, expect } from 'vitest';
import {
  filterProfileRaw,
  profileFilterScopeReport,
  GROUND_CLASS,
  PROFILE_FILTER_SCOPES,
  type ProfileRawFilterRequest,
} from '../src/render/measure/profileRawFilter';
import {
  ProfileSectionBuilder,
  profileSectionHas,
  type ProfileSectionPoints,
} from '../src/render/measure/profileSectionBuilder';
import { NON_GROUND_CLASSES } from '../src/terrain/ground/classificationFilter';
import { sampleProfile, type ProfileSample } from '../src/render/measure/profileSampler';

/** Slot of the classified source. Not equal to any point index it contributes. */
const SLOT_CLASSIFIED = 4;
/** Slot of the source with no channels at all. */
const SLOT_BARE = 9;

/** Classes of the classified source, index-aligned. */
const CLASSES = [2, 5, 2, 6, 0, 3, 2, 18, 9, 4, 7, 2];
const BARE_COUNT = 6;

const CLASSIFIED_COUNT = CLASSES.length; // 12
const TOTAL = CLASSIFIED_COUNT + BARE_COUNT; // 18

/** Section-relative geometry; distinct per point so a shuffle would show. */
const chainageAt = (slot: number, i: number): number => slot * 100 + i * 1.5;
const heightAt = (slot: number, i: number): number => 320.125 + slot * 0.5 + i * 0.25;
const lateralAt = (slot: number, i: number): number => (i % 5) * 0.2 - 0.4 + slot * 0.01;

/**
 * Two sources: one classified at slot 4, one carrying no channels at slot 9.
 * The bare source's points land in the emitted classification array as stored
 * zeros with their presence bit clear, which is exactly the case a class filter
 * must not read as class 0.
 */
function buildSection(withClassification = true): ProfileSectionPoints {
  const b = new ProfileSectionBuilder();
  if (withClassification) {
    const cls = Uint8Array.from(CLASSES);
    b.beginSource(SLOT_CLASSIFIED, { classification: cls }, CLASSIFIED_COUNT);
  } else {
    b.beginSource(SLOT_CLASSIFIED, null, CLASSIFIED_COUNT);
  }
  for (let i = 0; i < CLASSIFIED_COUNT; i++) {
    b.push(
      i,
      chainageAt(SLOT_CLASSIFIED, i),
      heightAt(SLOT_CLASSIFIED, i),
      lateralAt(SLOT_CLASSIFIED, i),
    );
  }
  b.beginSource(SLOT_BARE, null, BARE_COUNT);
  for (let i = 0; i < BARE_COUNT; i++) {
    b.push(i, chainageAt(SLOT_BARE, i), heightAt(SLOT_BARE, i), lateralAt(SLOT_BARE, i));
  }
  return b.finish();
}

/** Every array of a section, as plain values, for a byte-level equality check. */
function snapshot(p: ProfileSectionPoints): string {
  const arr = (a: ArrayLike<number> | undefined): number[] | null =>
    a === undefined ? null : Array.from(a);
  return JSON.stringify({
    count: p.count,
    chainage: arr(p.chainage),
    height: arr(p.height),
    lateralOffset: arr(p.lateralOffset),
    sourceSlot: arr(p.sourceSlot),
    pointIndex: arr(p.pointIndex),
    channelPresence: arr(p.channelPresence),
    rgb: arr(p.rgb),
    intensity: arr(p.intensity),
    classification: arr(p.classification),
    returnNumber: arr(p.returnNumber),
    returnCount: arr(p.returnCount),
    pointSourceId: arr(p.pointSourceId),
    gpsTime: arr(p.gpsTime),
    normals: arr(p.normals),
  });
}

/** Indices of the fixture's classified points whose class satisfies `pred`. */
function classifiedWhere(pred: (c: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < CLASSIFIED_COUNT; i++) if (pred(CLASSES[i]!)) out.push(i);
  return out;
}

/** Section indices of the bare source's points. */
const BARE_INDICES = Array.from({ length: BARE_COUNT }, (_, i) => CLASSIFIED_COUNT + i);

describe('profile raw filter: the default is the accepted population', () => {
  it('keeps every accepted corridor return, including the classes the reducer drops', () => {
    const points = buildSection();
    const { indices, descriptor } = filterProfileRaw(points);

    expect(indices.length).toBe(TOTAL);
    expect(Array.from(indices)).toEqual(Array.from({ length: TOTAL }, (_, i) => i));
    expect(descriptor.keptCount).toBe(TOTAL);
    expect(descriptor.acceptedCount).toBe(TOTAL);

    // The structure the derived series reduces away is present in the default.
    const nonGroundHere = classifiedWhere((c) => NON_GROUND_CLASSES.includes(c));
    expect(nonGroundHere.length).toBe(6);
    for (const i of nonGroundHere) expect(Array.from(indices)).toContain(i);

    expect(profileFilterScopeReport(descriptor, 'rawAttribute').active).toBe(false);
    expect(profileFilterScopeReport(descriptor, 'rawAttribute').removed).toBe(0);
    expect(descriptor.activeScopes).toEqual(['corridor']);
  });

  it('keeps the unclassified source under the default', () => {
    const points = buildSection();
    const { indices, descriptor } = filterProfileRaw(points, { filter: { kind: 'all' } });
    for (const i of BARE_INDICES) expect(Array.from(indices)).toContain(i);
    expect(descriptor.unclassifiedReaching).toBe(BARE_COUNT);
    expect(descriptor.unclassifiedKept).toBe(BARE_COUNT);
  });
});

describe('profile raw filter: attribute rules', () => {
  it('selects an explicit ASPRS class set', () => {
    const points = buildSection();
    const wanted = [GROUND_CLASS, 9];
    const { indices, descriptor } = filterProfileRaw(points, {
      filter: { kind: 'classes', classes: wanted },
    });

    const expected = classifiedWhere((c) => wanted.includes(c));
    expect(expected.length).toBe(5); // four ground, one water
    expect(Array.from(indices)).toEqual(expected);
    expect(descriptor.keptCount).toBe(5);
    expect(profileFilterScopeReport(descriptor, 'rawAttribute').removed).toBe(TOTAL - 5);
  });

  it('selects ground class 2 only', () => {
    const points = buildSection();
    const { indices, descriptor } = filterProfileRaw(points, { filter: { kind: 'ground' } });

    const expected = classifiedWhere((c) => c === GROUND_CLASS);
    expect(expected.length).toBe(4);
    expect(Array.from(indices)).toEqual(expected);
    for (const i of indices) expect(points.classification![i]).toBe(GROUND_CLASS);
    expect(descriptor.classificationAvailable).toBe(true);
    expect(descriptor.keptCount).toBe(4);
    expect(profileFilterScopeReport(descriptor, 'rawAttribute').removed).toBe(14);
  });

  it('mirrors the derived reducer exclusions from the shared class list', () => {
    const points = buildSection();
    const { indices, descriptor } = filterProfileRaw(points, {
      filter: { kind: 'excludeNonGround' },
    });

    const dropped = classifiedWhere((c) => NON_GROUND_CLASSES.includes(c));
    const expected = [
      ...classifiedWhere((c) => !NON_GROUND_CLASSES.includes(c)),
      ...BARE_INDICES,
    ].sort((x, y) => x - y);

    expect(Array.from(indices)).toEqual(expected);
    expect(descriptor.keptCount).toBe(TOTAL - dropped.length);
    expect(profileFilterScopeReport(descriptor, 'rawAttribute').removed).toBe(dropped.length);

    // Every removal is a class the reducer's own list names, and each of them.
    const removedClasses = Object.keys(descriptor.removedByClass)
      .map(Number)
      .sort((x, y) => x - y);
    expect(removedClasses).toEqual([...NON_GROUND_CLASSES].sort((x, y) => x - y));
    for (const c of NON_GROUND_CLASSES) expect(descriptor.removedByClass[c]).toBe(1);

    // Ground, class 0 and water survive, matching what the reducer accepts.
    for (const i of classifiedWhere((c) => c === 0 || c === GROUND_CLASS || c === 9)) {
      expect(Array.from(indices)).toContain(i);
    }
  });
});

describe('profile raw filter: unclassified points', () => {
  it('never reads a cleared classification bit as class 0', () => {
    const points = buildSection();
    // The bare source's stored classification bytes really are zero.
    for (const i of BARE_INDICES) {
      expect(points.classification![i]).toBe(0);
      expect(profileSectionHas(points, i, 'classification')).toBe(false);
    }

    const { indices, descriptor } = filterProfileRaw(points, {
      filter: { kind: 'classes', classes: [0] },
    });

    // Only the one point actually assigned class 0.
    expect(Array.from(indices)).toEqual(classifiedWhere((c) => c === 0));
    expect(indices.length).toBe(1);
    for (const i of BARE_INDICES) expect(Array.from(indices)).not.toContain(i);
    expect(descriptor.unclassifiedReaching).toBe(BARE_COUNT);
    expect(descriptor.unclassifiedKept).toBe(0);
    // Unclassified removals are not attributed to any class.
    expect(descriptor.removedByClass[0]).toBeUndefined();
  });

  it('drops unclassified points from a membership rule and keeps them under exclusion', () => {
    const points = buildSection();
    const ground = filterProfileRaw(points, { filter: { kind: 'ground' } });
    expect(ground.descriptor.unclassifiedKept).toBe(0);

    const exclude = filterProfileRaw(points, { filter: { kind: 'excludeNonGround' } });
    expect(exclude.descriptor.unclassifiedReaching).toBe(BARE_COUNT);
    expect(exclude.descriptor.unclassifiedKept).toBe(BARE_COUNT);
  });

  it('keeps nothing under a membership rule when no source classifies', () => {
    const points = buildSection(false);
    expect(points.classification).toBeUndefined();

    const ground = filterProfileRaw(points, { filter: { kind: 'ground' } });
    expect(ground.descriptor.classificationAvailable).toBe(false);
    expect(ground.indices.length).toBe(0);
    expect(ground.descriptor.unclassifiedReaching).toBe(TOTAL);

    // The default is unaffected by the missing channel.
    expect(filterProfileRaw(points).indices.length).toBe(TOTAL);
    // So is an exclusion rule, which needs evidence to remove anything.
    const exclude = filterProfileRaw(points, { filter: { kind: 'excludeNonGround' } });
    expect(exclude.indices.length).toBe(TOTAL);
    expect(exclude.descriptor.unclassifiedKept).toBe(TOTAL);
  });
});

describe('profile raw filter: source scope', () => {
  it('matches the recorded slot, not the point index or the list position', () => {
    const points = buildSection();
    const { indices, descriptor } = filterProfileRaw(points, { slots: [SLOT_BARE] });

    expect(Array.from(indices)).toEqual(BARE_INDICES);
    for (const i of indices) expect(points.sourceSlot[i]).toBe(SLOT_BARE);
    expect(descriptor.keptCount).toBe(BARE_COUNT);
    expect(profileFilterScopeReport(descriptor, 'source').removed).toBe(CLASSIFIED_COUNT);
    expect(profileFilterScopeReport(descriptor, 'source').active).toBe(true);

    // Slot 9 is not a point index of that source, and index 9 belongs to the
    // other source, so an index-keyed match yields a different set entirely.
    expect(Array.from(indices)).not.toContain(SLOT_BARE);
  });

  it('composes with an attribute rule and reports the two removals separately', () => {
    const points = buildSection();
    const { indices, descriptor } = filterProfileRaw(points, {
      slots: [SLOT_CLASSIFIED],
      filter: { kind: 'ground' },
    });

    expect(Array.from(indices)).toEqual(classifiedWhere((c) => c === GROUND_CLASS));
    expect(profileFilterScopeReport(descriptor, 'source').removed).toBe(BARE_COUNT);
    expect(profileFilterScopeReport(descriptor, 'rawAttribute').removed).toBe(
      CLASSIFIED_COUNT - 4,
    );
    expect(descriptor.keptCount).toBe(4);
    // Only points the source scope let through are counted as reaching the
    // attribute filter, so the unclassified source is not double counted.
    expect(descriptor.unclassifiedReaching).toBe(0);
    expect(descriptor.activeScopes).toEqual(['corridor', 'source', 'rawAttribute']);
  });

  it('treats an empty slot list as an empty selection and an absent one as no filter', () => {
    const points = buildSection();
    const empty = filterProfileRaw(points, { slots: [] });
    expect(empty.indices.length).toBe(0);
    expect(profileFilterScopeReport(empty.descriptor, 'source').active).toBe(true);
    expect(profileFilterScopeReport(empty.descriptor, 'source').removed).toBe(TOTAL);

    const none = filterProfileRaw(points, { slots: null });
    expect(none.indices.length).toBe(TOTAL);
    expect(profileFilterScopeReport(none.descriptor, 'source').active).toBe(false);
  });
});

describe('profile raw filter: descriptor keeps the four scopes apart', () => {
  it('reports every scope once, in order', () => {
    const points = buildSection();
    const { descriptor } = filterProfileRaw(points);
    expect(descriptor.scopes.map((s) => s.scope)).toEqual([...PROFILE_FILTER_SCOPES]);
    expect(new Set(descriptor.scopes.map((s) => s.scope)).size).toBe(4);
  });

  it('accounts for every accepted return through the two observable scopes', () => {
    const points = buildSection();
    for (const request of [
      {},
      { filter: { kind: 'ground' } },
      { filter: { kind: 'excludeNonGround' } },
      { filter: { kind: 'classes', classes: [2, 5] } },
      { slots: [SLOT_BARE] },
      { slots: [SLOT_CLASSIFIED], filter: { kind: 'classes', classes: [0, 9] } },
    ] as ProfileRawFilterRequest[]) {
      const { indices, descriptor } = filterProfileRaw(points, request);
      const source = profileFilterScopeReport(descriptor, 'source').removed!;
      const attribute = profileFilterScopeReport(descriptor, 'rawAttribute').removed!;

      expect(indices.length).toBe(descriptor.keptCount);
      expect(descriptor.keptCount + source + attribute).toBe(descriptor.acceptedCount);
      expect(descriptor.acceptedCount).toBe(points.count);
      // Indices are ascending and inside the section's index space.
      for (let k = 1; k < indices.length; k++) expect(indices[k]!).toBeGreaterThan(indices[k - 1]!);
      for (const i of indices) expect(i).toBeLessThan(points.count);
      // Removals attributed to classes cannot exceed the attribute removal.
      const byClass = Object.values(descriptor.removedByClass).reduce((a, b) => a + b, 0);
      expect(byClass).toBeLessThanOrEqual(attribute);
    }
  });

  it('leaves the corridor and derived-reducer counts unstated rather than zero', () => {
    const points = buildSection();
    const { descriptor } = filterProfileRaw(points, { filter: { kind: 'excludeNonGround' } });

    const corridor = profileFilterScopeReport(descriptor, 'corridor');
    expect(corridor.active).toBe(true);
    expect(corridor.removed).toBeNull();

    // Mirroring the reducer's class list does not make the reducer's own scope
    // active: the raw scatter and the derived series stay separately described.
    const derived = profileFilterScopeReport(descriptor, 'derivedReducer');
    expect(derived.active).toBe(false);
    expect(derived.removed).toBeNull();
    expect(descriptor.activeScopes).not.toContain('derivedReducer');
    expect(descriptor.activeScopes).toContain('rawAttribute');
  });

  it('names the rule each scope applied', () => {
    const points = buildSection();
    const ground = filterProfileRaw(points, { slots: [SLOT_CLASSIFIED], filter: { kind: 'ground' } });
    expect(profileFilterScopeReport(ground.descriptor, 'rawAttribute').rule).toContain('ground');
    expect(profileFilterScopeReport(ground.descriptor, 'source').rule).toContain(
      String(SLOT_CLASSIFIED),
    );
    const all = filterProfileRaw(points);
    expect(profileFilterScopeReport(all.descriptor, 'rawAttribute').rule).toContain('accepted');
  });
});

describe('profile raw filter: purity', () => {
  it('does not mutate the section', () => {
    const points = buildSection();
    const before = snapshot(points);
    const slots = [SLOT_BARE, SLOT_CLASSIFIED];
    const classes = [5, 2, 2, 0];
    const classesBefore = [...classes];

    filterProfileRaw(points);
    filterProfileRaw(points, { filter: { kind: 'ground' } });
    filterProfileRaw(points, { filter: { kind: 'excludeNonGround' } });
    filterProfileRaw(points, { slots, filter: { kind: 'classes', classes } });

    expect(snapshot(points)).toBe(before);
    expect(slots).toEqual([SLOT_BARE, SLOT_CLASSIFIED]);
    expect(classes).toEqual(classesBefore);
    expect(NON_GROUND_CLASSES).toEqual([3, 4, 5, 6, 7, 18]);
  });

  it('returns a fresh array on each call', () => {
    const points = buildSection();
    const a = filterProfileRaw(points).indices;
    const b = filterProfileRaw(points).indices;
    expect(a).not.toBe(b);
    a[0] = 999;
    expect(filterProfileRaw(points).indices[0]).toBe(0);
  });
});

describe('profile raw filter: the derived series is untouched', () => {
  /** A corridor of returns along +X: ground at 10 m, canopy above it. */
  function derivedInputs(): { positions: Float32Array; classification: Uint8Array } {
    const n = 40;
    const positions = new Float32Array(n * 3);
    const classification = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const canopy = i % 4 === 1;
      positions[i * 3] = i * 0.5;
      positions[i * 3 + 1] = ((i % 3) - 1) * 0.1;
      positions[i * 3 + 2] = canopy ? 14 + (i % 7) * 0.3 : 10 + (i % 5) * 0.02;
      classification[i] = canopy ? 5 : 2;
    }
    return { positions, classification };
  }

  const series = (positions: Float32Array, classification: Uint8Array): ProfileSample[] =>
    sampleProfile({
      a: [0, 0, 0],
      b: [19.5, 0, 0],
      up: [0, 0, 1],
      positions,
      samples: 8,
      bandWidth: 1,
      groundPercentile: 25,
      classification,
    });

  it('produces the same samples before and after raw filters run', () => {
    const { positions, classification } = derivedInputs();
    const before = series(positions, classification);
    const positionsBefore = Array.from(positions);
    const classificationBefore = Array.from(classification);

    const points = buildSection();
    filterProfileRaw(points, { filter: { kind: 'ground' } });
    filterProfileRaw(points, { filter: { kind: 'excludeNonGround' } });
    filterProfileRaw(points, { slots: [SLOT_BARE] });

    const after = series(positions, classification);
    expect(after).toEqual(before);
    expect(Array.from(positions)).toEqual(positionsBefore);
    expect(Array.from(classification)).toEqual(classificationBefore);
  });

  it('shows canopy the derived series has already reduced away', () => {
    const { positions, classification } = derivedInputs();
    const reduced = series(positions, classification);
    const reducedMax = Math.max(...reduced.map((s) => s.height).filter(Number.isFinite));

    const points = buildSection();
    const raw = filterProfileRaw(points);
    const heights = Array.from(raw.indices).map((i) => points.height[i]!);

    // The reducer's surface sits at ground level; the raw scatter still holds
    // the vegetation-classed returns that never reached it.
    expect(reducedMax).toBeLessThan(12);
    expect(heights.length).toBe(TOTAL);
    const vegetationKept = classifiedWhere((c) => NON_GROUND_CLASSES.includes(c)).every((i) =>
      Array.from(raw.indices).includes(i),
    );
    expect(vegetationKept).toBe(true);
  });
});
