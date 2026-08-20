import { describe, it, expect, vi } from 'vitest';
import {
  LayerGroupStore,
  bulkAppearanceIntent,
  groupVisibilityIntent,
  newGroupId,
  soloGroupIntent,
  type LayerGroup,
} from '../src/model/layerGroups';

/** A store whose ids are deterministic, so assertions can name them. */
function store(): LayerGroupStore {
  let n = 0;
  return new LayerGroupStore({ generateId: () => `g${++n}` });
}

/** A group value built without a store, for the pure intent functions. */
function group(memberIds: readonly string[], name = 'Flight 1'): LayerGroup {
  return { id: 'g1', name, memberIds, collapsed: false };
}

describe('group identity', () => {
  /**
   * Catches identity taken from the name or the list position. Two flights are
   * routinely both called "Flight 2", and a renamed or re-ordered group must
   * still be the same group — the index-as-id defect that renamed things on
   * every re-run.
   */
  it('keeps ids stable across rename, reorder and duplicate names', () => {
    const s = store();
    const first = s.create('Flight 1');
    const second = s.create('Flight 1');
    expect(first.id).not.toBe(second.id);
    expect(s.groups().map((g) => g.name)).toEqual(['Flight 1', 'Flight 1']);

    expect(s.rename(first.id, 'Morning pass')!.id).toBe(first.id);
    expect(s.get(first.id)!.name).toBe('Morning pass');
    // Deleting the group ABOVE must not shift what the surviving id refers to.
    s.delete(first.id);
    expect(s.groups()).toHaveLength(1);
    expect(s.get(second.id)!.name).toBe('Flight 1');
  });

  /**
   * Catches an id generator whose collisions merge two groups into one record.
   * A session import will one day replay ids minted in another run.
   */
  it('never hands out an id that is already in use', () => {
    let n = 0;
    // Repeats 'dup' once before moving on.
    const ids = ['dup', 'dup', 'fresh'];
    const s = new LayerGroupStore({ generateId: () => ids[n++] });
    const a = s.create('A');
    const b = s.create('B');
    expect(a.id).toBe('dup');
    expect(b.id).toBe('fresh');
    expect(s.groups()).toHaveLength(2);
  });

  /** Catches an id derived from the group's name or its ordinal. */
  it('mints ids that carry no name or position', () => {
    const id = newGroupId();
    expect(id.startsWith('group_')).toBe(true);
    expect(newGroupId()).not.toBe(id);
  });

  /**
   * Catches a blank label reaching the panel. A create call always comes from a
   * control with a default label, so a blank one is a caller bug and throws; a
   * blank rename is a user clearing a text field and is merely refused, leaving
   * the previous name standing.
   */
  it('refuses blank names, and trims the rest', () => {
    const s = store();
    expect(() => s.create('   ')).toThrow(/non-blank name/);
    const g = s.create('  Flight 2  ');
    expect(g.name).toBe('Flight 2');
    expect(s.rename(g.id, '  ')).toBeNull();
    expect(s.get(g.id)!.name).toBe('Flight 2');
    expect(s.rename('no-such-group', 'x')).toBeNull();
  });
});

describe('exclusive membership', () => {
  /**
   * Catches a layer left in two groups at once. Overlapping membership lets two
   * groups issue contradictory visibility plans for the same layer, and makes
   * `groupOf` a lie.
   */
  it('moves a layer out of its old group when it joins a second', () => {
    const s = store();
    const a = s.create('Flight 1', ['c1', 'c2']);
    const b = s.create('Flight 2', ['c3']);

    s.addMember(b.id, 'c2');
    expect(s.membersOf(a.id)).toEqual(['c1']);
    expect(s.membersOf(b.id)).toEqual(['c3', 'c2']);
    expect(s.groupOf('c2')!.id).toBe(b.id);
  });

  /**
   * Catches a duplicated row, and catches a re-add that quietly sends a member
   * to the bottom of its own group. Both surface as a double click reordering
   * or doubling the panel.
   */
  it('re-adding a member is a no-op that keeps its position', () => {
    const s = store();
    const a = s.create('Flight 1', ['c1', 'c2', 'c3']);
    s.addMember(a.id, 'c1');
    expect(s.membersOf(a.id)).toEqual(['c1', 'c2', 'c3']);
    // A repeated seed in the constructor list is the same case.
    const b = s.create('Flight 2', ['c9', 'c9']);
    expect(s.membersOf(b.id)).toEqual(['c9']);
  });

  /**
   * Catches the member array and the owner index falling out of step — the
   * failure where `membersOf` still lists a layer that `groupOf` says is
   * ungrouped, so the panel draws it twice or not at all.
   */
  it('keeps membersOf and groupOf agreeing through every membership change', () => {
    const s = store();
    const a = s.create('Flight 1', ['c1', 'c2']);
    const b = s.create('Flight 2');

    expect(s.removeMember(a.id, 'c1')).toBe(true);
    expect(s.groupOf('c1')).toBeNull();
    expect(s.membersOf(a.id)).toEqual(['c2']);
    // Removing from the wrong group changes nothing.
    expect(s.removeMember(b.id, 'c2')).toBe(false);
    expect(s.groupOf('c2')!.id).toBe(a.id);

    expect(s.forgetLayer('c2')).toBe(true);
    expect(s.groupOf('c2')).toBeNull();
    expect(s.membersOf(a.id)).toEqual([]);
    expect(s.forgetLayer('c2')).toBe(false);

    expect(s.addMember('no-such-group', 'c1')).toBeNull();
    expect(s.groupOf('c1')).toBeNull();
  });

  /**
   * Catches a group delete that takes the loaded scans with it. Deleting a
   * container is an organisational act; the layers stay in the scene and become
   * ungrouped.
   */
  it('deleting a group ungroups its members rather than losing them', () => {
    const s = store();
    const a = s.create('Flight 1', ['c1', 'c2']);
    expect(s.delete(a.id)).toBe(true);
    expect(s.delete(a.id)).toBe(false);
    expect(s.groupOf('c1')).toBeNull();
    expect(s.ungrouped(['c1', 'c2'])).toEqual(['c1', 'c2']);
    expect(s.tree(['c1', 'c2'])).toEqual([
      { kind: 'layer', layerId: 'c1' },
      { kind: 'layer', layerId: 'c2' },
    ]);
  });

  /** Catches a collapsed flag that does not round-trip, or leaks into membership. */
  it('collapses and expands without touching membership', () => {
    const s = store();
    const a = s.create('Flight 1', ['c1']);
    expect(a.collapsed).toBe(false);
    expect(s.setCollapsed(a.id, true)!.collapsed).toBe(true);
    expect(s.get(a.id)!.memberIds).toEqual(['c1']);
    expect(s.setCollapsed(a.id, false)!.collapsed).toBe(false);
    expect(s.setCollapsed('no-such-group', true)).toBeNull();
  });

  /**
   * Catches a snapshot that hands out the store's own array. A caller mutating
   * what it got back would rewrite membership through a read method.
   */
  it('hands out copies, so a caller cannot edit membership through a read', () => {
    const s = store();
    const a = s.create('Flight 1', ['c1']);
    (s.get(a.id)!.memberIds as string[]).push('c2');
    (s.membersOf(a.id) as string[]).push('c3');
    expect(s.membersOf(a.id)).toEqual(['c1']);
  });
});

describe('layers the scene has closed', () => {
  /**
   * Catches a group resurrecting a dead id: the layer is gone from the viewer,
   * but a group operation still names it and the caller tries to show, hide or
   * restyle something that no longer exists.
   */
  it('never emits a member the live layer set does not contain', () => {
    const s = store();
    const a = s.create('Flight 1', ['c1', 'c2', 'c3']);
    const live = ['c1', 'c3', 'c9'];

    // Recorded membership still knows about c2 until reconcile runs.
    expect(s.membersOf(a.id)).toEqual(['c1', 'c2', 'c3']);
    // Everything that acts on layers has already dropped it.
    expect(s.liveMembersOf(a.id, live)).toEqual(['c1', 'c3']);
    expect(soloGroupIntent(s.get(a.id)!, live)!.visible).toEqual(['c1', 'c3']);
    expect(
      bulkAppearanceIntent(
        s.get(a.id)!,
        live.map((id) => ({ id, inSharedFrame: true })),
        'per-layer',
      ).applyTo,
    ).toEqual(['c1', 'c3']);
    for (const node of s.tree(live)) {
      if (node.kind === 'group') expect(node.memberIds).not.toContain('c2');
    }
  });

  /**
   * Catches a reconcile that either keeps ghosts or deletes the container. An
   * emptied group is still the group the user made; removing its last layer
   * must not delete it as a side effect.
   */
  it('reconcile drops closed members and keeps the emptied group', () => {
    const s = store();
    const a = s.create('Flight 1', ['c1', 'c2']);
    const b = s.create('Flight 2', ['c3']);

    s.reconcile(['c1']);
    expect(s.membersOf(a.id)).toEqual(['c1']);
    expect(s.membersOf(b.id)).toEqual([]);
    expect(s.has(b.id)).toBe(true);
    expect(s.groupOf('c3')).toBeNull();
    // c3 can be regrouped afterwards, which a stale owner index would refuse.
    expect(s.addMember(a.id, 'c3')!.memberIds).toEqual(['c1', 'c3']);
  });

  /**
   * Catches a group that inherits the state of layers that are gone: with every
   * member closed the answer is `empty`, not `all` (a checked box promising
   * six visible scans) and not `none`.
   */
  it('a group whose members all closed reports empty, and refuses solo', () => {
    const s = store();
    const a = s.create('Flight 1', ['c1', 'c2']);
    const g = s.get(a.id)!;
    expect(groupVisibilityIntent(g, new Map())).toBe('empty');
    expect(soloGroupIntent(g, ['c7', 'c8'])).toBeNull();
  });
});

describe('ungrouped layers stay reachable', () => {
  /**
   * Catches the defect that makes grouping destructive: a layer in no group
   * disappearing from the panel, because the tree was built from the groups
   * instead of from the loaded layers.
   */
  it('every loaded layer appears exactly once in the tree', () => {
    const s = store();
    const a = s.create('Flight 1', ['c2', 'c4']);
    s.create('Flight 2', ['c5']);
    const live = ['c1', 'c2', 'c3', 'c4', 'c5'];

    const nodes = s.tree(live);
    const seen: string[] = [];
    for (const node of nodes) {
      if (node.kind === 'group') seen.push(...node.memberIds);
      else seen.push(node.layerId);
    }
    expect(seen.slice().sort()).toEqual(live.slice().sort());
    expect(new Set(seen).size).toBe(seen.length);

    // Groups in creation order first, then the ungrouped layers in scene order.
    expect(nodes.map((n) => (n.kind === 'group' ? n.group.name : n.layerId))).toEqual([
      'Flight 1',
      'Flight 2',
      'c1',
      'c3',
    ]);
    expect(s.ungrouped(live)).toEqual(['c1', 'c3']);
    expect(s.groupOf('c1')).toBeNull();
    expect(s.groupOf('c4')!.id).toBe(a.id);
  });

  /**
   * Catches a tree whose group rows re-order themselves as unrelated scans load
   * and close. Members keep the order the user built them in.
   */
  it('keeps members in join order, not scene order', () => {
    const s = store();
    const a = s.create('Flight 1', ['c4', 'c2']);
    expect(s.liveMembersOf(a.id, ['c1', 'c2', 'c3', 'c4'])).toEqual(['c4', 'c2']);
    expect(s.liveMembersOf('no-such-group', ['c1'])).toEqual([]);
  });

  /** Catches a tree that invents rows when nothing is loaded at all. */
  it('an empty scene yields a group node with no members and no layer rows', () => {
    const s = store();
    s.create('Flight 1', ['c1']);
    expect(s.tree([])).toEqual([
      { kind: 'group', group: expect.objectContaining({ name: 'Flight 1' }), memberIds: [] },
    ]);
  });
});

describe('group visibility as an operation over member ids', () => {
  /**
   * Catches the whole class of bug a duplicate group-level visibility flag
   * would introduce: the flag says "shown" while a member underneath it is
   * hidden. The state is derived from the layers every time, so `mixed` is
   * reported instead of a stale `all`.
   */
  it('reports all, none and mixed from the per-layer intent map', () => {
    const visible = new Map([
      ['c1', true],
      ['c2', true],
      ['c3', false],
    ]);
    expect(groupVisibilityIntent(group(['c1', 'c2']), visible)).toBe('all');
    expect(groupVisibilityIntent(group(['c3']), visible)).toBe('none');
    expect(groupVisibilityIntent(group(['c1', 'c3']), visible)).toBe('mixed');
    expect(groupVisibilityIntent(group([]), visible)).toBe('empty');
  });

  /**
   * Catches a fold that counts closed layers. One hidden member out of three
   * must read `mixed`; a member the map has never heard of must not tip it
   * either way.
   */
  it('ignores members the visibility map does not know about', () => {
    const visible = new Map([
      ['c1', true],
      ['c2', true],
    ]);
    expect(groupVisibilityIntent(group(['c1', 'c2', 'gone']), visible)).toBe('all');
    expect(groupVisibilityIntent(group(['gone']), visible)).toBe('empty');
  });

  /**
   * Catches a solo that leaks a layer: the plan must partition the loaded set,
   * so no layer is left out of both lists and quietly keeps its old state while
   * the rest of the scene is isolated.
   */
  it('solo partitions the loaded layers into show and hide', () => {
    const live = ['c1', 'c2', 'c3', 'c4'];
    const plan = soloGroupIntent(group(['c2', 'c4']), live)!;
    expect(plan.visible).toEqual(['c2', 'c4']);
    expect(plan.hidden).toEqual(['c1', 'c3']);
    expect([...plan.visible, ...plan.hidden].slice().sort()).toEqual(live.slice().sort());
  });

  /**
   * Catches the blank-viewport defect: isolating a group with nothing loaded in
   * it would hide every layer, leaving nothing on screen to explain why.
   */
  it('refuses to isolate a group with no loaded member', () => {
    expect(soloGroupIntent(group([]), ['c1', 'c2'])).toBeNull();
    expect(soloGroupIntent(group(['c9']), ['c1', 'c2'])).toBeNull();
    // A single loaded member is enough to isolate on.
    expect(soloGroupIntent(group(['c9', 'c1']), ['c1', 'c2'])!.visible).toEqual(['c1']);
  });
});

describe('bulk appearance safety', () => {
  /**
   * Catches a bulk edit that refuses work it could safely do. Opacity, point
   * size and a picking lock mean the same thing on each layer independently, so
   * a group-wide edit is just several independent edits.
   */
  it('applies a per-layer property to every loaded member', () => {
    const members = [
      { id: 'c1', inSharedFrame: true },
      { id: 'c2', inSharedFrame: false },
      { id: 'c3', inSharedFrame: false },
    ];
    const plan = bulkAppearanceIntent(group(['c1', 'c2']), members, 'per-layer');
    expect(plan.applyTo).toEqual(['c1', 'c2']);
    expect(plan.withheld).toEqual([]);
    expect(plan.reason).toBe('');
  });

  /**
   * Catches a group-wide elevation ramp or colour scale spanning layers that do
   * not share a frame — a legend that claims to describe the group while the
   * heights under it sit on unrelated origins.
   */
  it('refuses a cross-layer property when a member is outside the shared frame', () => {
    const members = [
      { id: 'c1', inSharedFrame: true },
      { id: 'c2', inSharedFrame: false },
    ];
    const plan = bulkAppearanceIntent(group(['c1', 'c2']), members, 'cross-layer');
    expect(plan.applyTo).toEqual([]);
    expect(plan.withheld).toEqual(['c1', 'c2']);
    expect(plan.reason).toContain('1 of 2');
    expect(plan.reason).toContain('Flight 1');
  });

  /**
   * Catches a partial cross-layer apply. Styling only the qualifying half is
   * worse than refusing: the control says "the group" and the result would mean
   * "whichever members happened to qualify", with nothing saying so.
   */
  it('a cross-layer refusal is all-or-nothing, never the qualifying subset', () => {
    const members = [
      { id: 'c1', inSharedFrame: true },
      { id: 'c2', inSharedFrame: true },
      { id: 'c3', inSharedFrame: false },
    ];
    const plan = bulkAppearanceIntent(group(['c1', 'c2', 'c3']), members, 'cross-layer');
    expect(plan.applyTo).toEqual([]);
    expect(plan.withheld).toEqual(['c1', 'c2', 'c3']);
  });

  /**
   * Catches a frame check that reads the whole scene instead of the group. A
   * layer outside the frame and outside the group must not block the group's
   * own edit.
   */
  it('judges only the group, and allows a wholly in-frame group', () => {
    const members = [
      { id: 'c1', inSharedFrame: true },
      { id: 'c2', inSharedFrame: true },
      { id: 'c3', inSharedFrame: false },
    ];
    const plan = bulkAppearanceIntent(group(['c1', 'c2']), members, 'cross-layer');
    expect(plan.applyTo).toEqual(['c1', 'c2']);
    expect(plan.reason).toBe('');
  });
});

describe('the no-WebCrypto id fallback', () => {
  it('does not collide between two sessions that share a millisecond', async () => {
    const realNow = Date.now;
    // No randomUUID and no getRandomValues: the weakest host this runs on.
    vi.stubGlobal('crypto', {});
    // A frozen clock is the collision case: the session counter also restarts
    // at zero in a fresh process, so time plus counter alone repeat exactly.
    Date.now = () => 1_700_000_000_000;
    try {
      vi.resetModules();
      const first = (await import('../src/model/layerGroups')).newGroupId();
      vi.resetModules();
      const second = (await import('../src/model/layerGroups')).newGroupId();
      expect(second).not.toBe(first);
    } finally {
      Date.now = realNow;
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
