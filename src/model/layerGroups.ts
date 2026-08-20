/**
 * layerGroups.ts — organising loaded layers into named, collapsible groups.
 *
 * A survey flown as two passes of three strips arrives in the Layers panel as
 * six flat rows, and every operation on "the second flight" is the same click
 * repeated three times. This module is the container that makes such a set
 * addressable: a named group with a stable id, a member list, and a collapsed
 * flag.
 *
 * What it is deliberately NOT is a second layer store. A group holds ids and
 * nothing else — no visibility, no opacity, no lock, no CRS, no position in the
 * scene. All of that already lives in `AppContext.layers`, the viewer, and
 * `LayerService`, and duplicating any of it here would create two answers to
 * one question. So "hide this group" is not a flag that can drift out of step
 * with the six layers under it; it is a one-shot OPERATION whose result is a
 * list of member ids for the caller to push through `LayerService.setVisible`.
 * Solo is the same shape, which is why nothing here remembers a soloed group.
 *
 * Membership is EXCLUSIVE: a layer belongs to at most one group. That makes
 * {@link LayerGroupStore.groupOf} a function rather than a list, and gives
 * "show only this group" one unambiguous answer. Adding a layer to a second
 * group MOVES it out of the first. Overlapping membership would let two groups
 * issue contradictory visibility plans for the same layer, and nothing in the
 * workflow needs a layer to be in two flights at once.
 *
 * A group never proves a layer exists. The store holds ids the app handed it,
 * and the app closes scans without asking, so every function that emits ids
 * takes the LIVE id set and intersects with it. A closed scan can still be
 * listed as a member and will not appear in a visibility plan, a solo plan, an
 * appearance plan, or the tree. {@link LayerGroupStore.reconcile} is how those
 * stale entries are dropped for good, on the same cadence
 * `LayerService.refreshCrsFlags` already reconciles the project frame.
 *
 * Pure: no DOM, no three.js, no viewer, no imports at all. This is the model
 * only — the panel that renders a group, and the session that persists one, are
 * later steps that consume it.
 */

/**
 * A named, collapsible set of layer ids.
 *
 * Identity is {@link id} — never the name (two flights are routinely both
 * called "Flight 2") and never the position in the list (a re-ordered or
 * re-created list would rename every group under it, which is the index-as-id
 * defect this repository has already paid for once).
 */
export interface LayerGroup {
  /** Stable, generated identity. */
  readonly id: string;
  /** Display label. Mutable, non-blank, and not required to be unique. */
  readonly name: string;
  /**
   * Member layer ids in the order they joined. May still name a layer the
   * scene has closed; see {@link LayerGroupStore.reconcile}.
   */
  readonly memberIds: readonly string[];
  /** Whether the panel should draw the group folded shut. */
  readonly collapsed: boolean;
}

/** Session-local counter behind the no-WebCrypto fallback. */
let fallbackGroupCounter = 0;

/**
 * Mint a fresh group id.
 *
 * Random where WebCrypto offers it, monotonic time plus a counter otherwise.
 * Either way it is derived from neither the group's name nor its position, so
 * renaming a group or reordering the list cannot change which group an id
 * refers to. Never a secret — a group id is an internal handle.
 */
export function newGroupId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return `group_${c.randomUUID()}`;
  return `group_${Date.now().toString(36)}_${(fallbackGroupCounter++).toString(36)}`;
}

export interface LayerGroupStoreOptions {
  /** Override the id generator (tests inject a deterministic counter). */
  readonly generateId?: () => string;
}

/** Internal mutable record; {@link LayerGroup} is the snapshot handed out. */
interface MutableGroup {
  name: string;
  readonly memberIds: string[];
  collapsed: boolean;
}

/** One node of the Layers panel's ordered tree. */
export type LayerTreeNode =
  | {
      readonly kind: 'group';
      readonly group: LayerGroup;
      /** The group's members that are actually loaded, in join order. */
      readonly memberIds: readonly string[];
    }
  | { readonly kind: 'layer'; readonly layerId: string };

/**
 * The groups of one session, keyed by group id and held in creation order.
 *
 * Holds group records and membership. Nothing else: no layer state passes
 * through here, and no method returns a layer's visibility, appearance, or
 * order — those are read from, and written to, the services that own them.
 */
export class LayerGroupStore {
  private readonly _byId = new Map<string, MutableGroup>();
  /**
   * layer id → owning group id. The exclusivity index, kept in step with the
   * member arrays by {@link _detach} and {@link addMember}; every membership
   * change must touch both or `groupOf` starts disagreeing with `membersOf`.
   */
  private readonly _owner = new Map<string, string>();
  private readonly _gen: () => string;

  constructor(options: LayerGroupStoreOptions = {}) {
    this._gen = options.generateId ?? newGroupId;
  }

  /**
   * Create a group, optionally seeded with members. Each seed is MOVED out of
   * whatever group already held it.
   *
   * A blank name throws rather than being accepted, because a group is created
   * from a control that always supplies a default label — a blank one reaching
   * here is a caller bug, not a user action, and a nameless row in the panel
   * cannot be told apart from its neighbours. (A blank RENAME is a user action
   * and is merely refused; see {@link rename}.)
   */
  create(name: string, memberIds: readonly string[] = []): LayerGroup {
    const label = name.trim();
    if (label === '') {
      throw new Error('LayerGroupStore.create: a group needs a non-blank name.');
    }
    const id = this._mintId();
    this._byId.set(id, { name: label, memberIds: [], collapsed: false });
    for (const layerId of memberIds) this.addMember(id, layerId);
    return this._snapshot(id)!;
  }

  /**
   * Relabel a group. The trimmed name must be non-blank and need not be unique
   * — identity is the id, so two groups may legitimately both be "Flight 2".
   * Returns null (leaving the group untouched) for an unknown id or a blank
   * name.
   */
  rename(groupId: string, name: string): LayerGroup | null {
    const group = this._byId.get(groupId);
    if (!group) return null;
    const label = name.trim();
    if (label === '') return null;
    group.name = label;
    return this._snapshot(groupId);
  }

  /** Fold or unfold the group in the panel. */
  setCollapsed(groupId: string, collapsed: boolean): LayerGroup | null {
    const group = this._byId.get(groupId);
    if (!group) return null;
    group.collapsed = collapsed;
    return this._snapshot(groupId);
  }

  /**
   * Delete the group. Its members become ungrouped and stay loaded: a container
   * disappearing must not take the scans inside it out of the scene.
   */
  delete(groupId: string): boolean {
    const group = this._byId.get(groupId);
    if (!group) return false;
    for (const layerId of group.memberIds) {
      if (this._owner.get(layerId) === groupId) this._owner.delete(layerId);
    }
    return this._byId.delete(groupId);
  }

  /**
   * Put a layer in a group, moving it out of any group that already held it
   * (membership is exclusive). Re-adding a layer to the group it is already in
   * is a no-op that keeps its position, so a double click cannot duplicate a
   * row or send a member to the bottom of its own list.
   */
  addMember(groupId: string, layerId: string): LayerGroup | null {
    const group = this._byId.get(groupId);
    if (!group) return null;
    const previous = this._owner.get(layerId);
    if (previous === groupId) return this._snapshot(groupId);
    if (previous !== undefined) this._detach(previous, layerId);
    group.memberIds.push(layerId);
    this._owner.set(layerId, groupId);
    return this._snapshot(groupId);
  }

  /**
   * Take a layer out of a group; it becomes ungrouped and stays loaded. False
   * when that group does not hold that layer.
   */
  removeMember(groupId: string, layerId: string): boolean {
    if (this._owner.get(layerId) !== groupId) return false;
    this._detach(groupId, layerId);
    return true;
  }

  /** Drop one closed layer from whatever group held it. False when ungrouped. */
  forgetLayer(layerId: string): boolean {
    const owner = this._owner.get(layerId);
    if (owner === undefined) return false;
    this._detach(owner, layerId);
    return true;
  }

  /**
   * Drop every member id absent from `liveLayerIds`.
   *
   * Empty groups are KEPT. A group whose last scan was closed is still the
   * container the user made, and deleting it on a routine reconcile would
   * destroy it as a side effect of removing a layer. The cost is that a scan
   * closed and reopened does not rejoin its old group by itself; that is a
   * deliberate trade, and the read paths never resurrect a dead id in the
   * meantime because they all intersect with the live set anyway.
   */
  reconcile(liveLayerIds: Iterable<string>): void {
    const live = new Set(liveLayerIds);
    for (const [groupId, group] of this._byId) {
      for (let i = group.memberIds.length - 1; i >= 0; i--) {
        const layerId = group.memberIds[i];
        if (live.has(layerId)) continue;
        group.memberIds.splice(i, 1);
        if (this._owner.get(layerId) === groupId) this._owner.delete(layerId);
      }
    }
  }

  /** The group with this id, or null. */
  get(groupId: string): LayerGroup | null {
    return this._snapshot(groupId);
  }

  has(groupId: string): boolean {
    return this._byId.has(groupId);
  }

  /** Every group, in creation order. */
  groups(): LayerGroup[] {
    const out: LayerGroup[] = [];
    for (const groupId of this._byId.keys()) out.push(this._snapshot(groupId)!);
    return out;
  }

  /** The group holding this layer, or null when it is ungrouped. */
  groupOf(layerId: string): LayerGroup | null {
    const groupId = this._owner.get(layerId);
    return groupId === undefined ? null : this._snapshot(groupId);
  }

  /**
   * A group's recorded members, in join order. May include layers the scene has
   * closed — use {@link liveMembersOf} for anything that acts on them.
   */
  membersOf(groupId: string): readonly string[] {
    const group = this._byId.get(groupId);
    return group ? [...group.memberIds] : [];
  }

  /**
   * A group's members that are actually loaded, in join order. Join order
   * rather than scene order so a group's rows keep the arrangement the user
   * built as other scans come and go.
   */
  liveMembersOf(groupId: string, allLayerIds: readonly string[]): readonly string[] {
    const group = this._byId.get(groupId);
    if (!group) return [];
    const live = new Set(allLayerIds);
    return group.memberIds.filter((layerId) => live.has(layerId));
  }

  /**
   * Loaded layers in no group, in scene order. Grouping is opt-in, so this is
   * the path by which an ungrouped layer stays reachable — it is never implied
   * by absence from some default group, because there is no default group.
   */
  ungrouped(allLayerIds: readonly string[]): readonly string[] {
    return allLayerIds.filter((layerId) => !this._owner.has(layerId));
  }

  /**
   * The panel's ordered tree: every group in creation order, then every
   * ungrouped layer in scene order.
   *
   * Built FROM `allLayerIds`, which is what makes the two invariants
   * structural rather than remembered: each loaded layer appears exactly once,
   * and a closed layer appears nowhere, whether or not {@link reconcile} has
   * run yet.
   */
  tree(allLayerIds: readonly string[]): readonly LayerTreeNode[] {
    const nodes: LayerTreeNode[] = [];
    for (const groupId of this._byId.keys()) {
      nodes.push({
        kind: 'group',
        group: this._snapshot(groupId)!,
        memberIds: this.liveMembersOf(groupId, allLayerIds),
      });
    }
    for (const layerId of this.ungrouped(allLayerIds)) {
      nodes.push({ kind: 'layer', layerId });
    }
    return nodes;
  }

  /** Detach a layer from a group, keeping the member array and the index in step. */
  private _detach(groupId: string, layerId: string): void {
    const group = this._byId.get(groupId);
    if (group) {
      const at = group.memberIds.indexOf(layerId);
      if (at >= 0) group.memberIds.splice(at, 1);
    }
    if (this._owner.get(layerId) === groupId) this._owner.delete(layerId);
  }

  /**
   * A free group id. The generator is allowed to repeat — a test injects a
   * counter, and a session import will one day hand back ids minted in another
   * run — and handing out a live id would silently merge two groups into one.
   */
  private _mintId(): string {
    let id = this._gen();
    for (let attempt = 0; this._byId.has(id); attempt++) {
      if (attempt >= 64) {
        throw new Error('LayerGroupStore: the id generator produced no free id.');
      }
      id = this._gen();
    }
    return id;
  }

  private _snapshot(groupId: string): LayerGroup | null {
    const group = this._byId.get(groupId);
    if (!group) return null;
    return {
      id: groupId,
      name: group.name,
      memberIds: [...group.memberIds],
      collapsed: group.collapsed,
    };
  }
}

/**
 * What a group's visibility control should read.
 *
 * `empty` is a distinct state, not a synonym for `none`. A group with no loaded
 * member has nothing hidden; reporting it as `none` would draw an unchecked box
 * that invites a click which does nothing. The same distinction the CRS model
 * makes between "can't compare" and "matches".
 */
export type GroupVisibility = 'all' | 'none' | 'mixed' | 'empty';

/**
 * Fold a group's members down to one visibility state.
 *
 * `layerVisibility` is the app's existing per-layer intent map
 * (`AppContext.layers.visible`), read here and never written. A member absent
 * from it is a layer the scene no longer holds and is ignored, so a group that
 * outlived its scans reports `empty` rather than inheriting the state of ghosts.
 */
export function groupVisibilityIntent(
  group: LayerGroup,
  layerVisibility: ReadonlyMap<string, boolean>,
): GroupVisibility {
  let shown = 0;
  let hidden = 0;
  for (const layerId of group.memberIds) {
    const visible = layerVisibility.get(layerId);
    if (visible === undefined) continue;
    if (visible) shown++;
    else hidden++;
  }
  if (shown + hidden === 0) return 'empty';
  if (hidden === 0) return 'all';
  if (shown === 0) return 'none';
  return 'mixed';
}

/** The layers to show and to hide when a group is isolated. */
export interface GroupSoloPlan {
  readonly visible: readonly string[];
  readonly hidden: readonly string[];
}

/**
 * Plan "show only this group" as a partition of the loaded layers.
 *
 * A plan, not a stored flag: the caller applies it through the visibility path
 * it already owns, so there is no group-solo state to fall out of step with the
 * layers. Both lists are built from `allLayerIds`, so a member the scene has
 * closed can never be handed back as something to show.
 *
 * Null when the group has no loaded member. Isolating an empty group would hide
 * every layer and leave a blank viewport with nothing on screen to explain it,
 * so the operation refuses and the caller can disable the control instead.
 */
export function soloGroupIntent(
  group: LayerGroup,
  allLayerIds: readonly string[],
): GroupSoloPlan | null {
  const members = new Set(group.memberIds);
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const layerId of allLayerIds) {
    if (members.has(layerId)) visible.push(layerId);
    else hidden.push(layerId);
  }
  return visible.length === 0 ? null : { visible, hidden };
}

/**
 * How an appearance property behaves across several layers.
 *
 * `per-layer` — the value stands on its own for each layer: opacity, point
 * size, a picking lock. Applying it to six layers is six independent edits and
 * is always safe.
 *
 * `cross-layer` — the value only reads correctly when the layers share a
 * spatial frame: an elevation ramp over one height range, a single colour scale
 * spanning the set. Pushing one of those onto layers that are not all mounted
 * in the project frame yields a legend that claims to describe the group and
 * describes only part of it, which is the same failure the viewer's shared
 * elevation range already refuses to compute.
 */
export type AppearanceScope = 'per-layer' | 'cross-layer';

/** The one fact a bulk appearance decision needs about a loaded member. */
export interface GroupMemberFrame {
  readonly id: string;
  /** True when the layer is mounted in the project's shared spatial frame. */
  readonly inSharedFrame: boolean;
}

/** Which members a bulk appearance edit may touch, and why the rest were left. */
export interface BulkAppearancePlan {
  readonly applyTo: readonly string[];
  /** Live members held back. Empty when the edit runs across the whole group. */
  readonly withheld: readonly string[];
  /** Plain-language reason, empty when nothing was withheld. */
  readonly reason: string;
}

/**
 * Decide which members of a group a bulk appearance edit may be applied to.
 *
 * `members` carries the loaded layers and their frame state; anything in the
 * group but not in `members` is a closed scan and is dropped, so a bulk edit
 * can never be aimed at a layer that is gone.
 *
 * A `cross-layer` edit is all-or-nothing. Applying it to the in-frame subset
 * would be worse than refusing: the control says "the group", and the result
 * would silently mean "the part of the group that happened to qualify".
 */
export function bulkAppearanceIntent(
  group: LayerGroup,
  members: readonly GroupMemberFrame[],
  scope: AppearanceScope,
): BulkAppearancePlan {
  const inGroup = new Set(group.memberIds);
  const live = members.filter((member) => inGroup.has(member.id));
  const ids = live.map((member) => member.id);
  if (scope === 'per-layer') return { applyTo: ids, withheld: [], reason: '' };
  const outside = live.filter((member) => !member.inSharedFrame);
  if (outside.length === 0) return { applyTo: ids, withheld: [], reason: '' };
  return {
    applyTo: [],
    withheld: ids,
    reason:
      `${outside.length} of ${ids.length} layers in "${group.name}" are not in the ` +
      "project's shared frame, so one value across the group would not describe them.",
  };
}
