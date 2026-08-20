/**
 * LayerGroupsPanel.ts — the Layers panel's group rows.
 *
 * The container model lives in `model/layerGroups.ts` and holds ids and nothing
 * else: no visibility, no appearance, no scene position. This is the view half.
 * It draws a group as a collapsible header over its member rows, and it turns
 * every group ACTION into the plan the model returns, then pushes that plan
 * through the per-layer path the app already owns (`LayerService.setVisible`,
 * reached here as {@link LayerGroupsPanelDeps.setVisible}).
 *
 * That is the whole discipline. "Hide this group" writes six layer visibilities
 * and stores nothing; "show only this group" writes a partition of the loaded
 * layers and stores nothing. A group header's checkbox is therefore always a
 * READING of its members, computed by `groupVisibilityIntent` at paint time, and
 * can never drift out of step with the rows beneath it — there is no second
 * copy of the answer to drift.
 *
 * The panel does not own layer rows either. The Inspector builds each
 * `.olv-layer` row and keeps its map of them; this module only re-parents those
 * live nodes under the group they belong to, so every listener, CRS flag and
 * class the Inspector puts on a row survives being grouped. An ungrouped layer
 * is appended exactly where it always was.
 *
 * LAZY. The Inspector loads this module (and the group model with it) on the
 * first "New group" click or the first session that carries an arrangement, so
 * a user who never groups anything pays nothing for it in the startup shell —
 * the `index` chunk has about 5 KiB of headroom and this is not startup code.
 * Until it loads there is no group state anywhere, which is why the Inspector's
 * ungrouped path is a plain list of rows and not a degraded version of this one.
 */

import { el } from './dom';
import {
  LayerGroupStore,
  groupVisibilityIntent,
  soloGroupIntent,
  type LayerGroup,
} from '../model/layerGroups';
import type { SessionLayerGroup } from '../io/session';

/** The running app's layer state, read and written through its existing owners. */
export interface LayerGroupsPanelDeps {
  /** Loaded layer ids, in scene order. */
  layerIds: () => readonly string[];
  /** A layer's display name. */
  nameOf: (layerId: string) => string;
  /** A layer's live row element, or null when it is not rendered. */
  rowFor: (layerId: string) => HTMLElement | null;
  /** A layer's show/hide INTENT (not its effective, solo-resolved visibility). */
  visibilityOf: (layerId: string) => boolean;
  /**
   * Write one layer's visibility. Wired to the same `LayerService.setVisible`
   * call a single row's checkbox makes, which is what keeps a group action and
   * a row click one mechanism rather than two.
   */
  setVisible: (layerId: string, visible: boolean) => void;
  /**
   * A layer's STABLE identity, or null when it carries none. Only used when
   * writing a session: membership persists by stable id, never by the viewer's
   * slot-numbered handle.
   */
  stableIdOf: (layerId: string) => string | null;
  /** Told when the selected group changes; `null` means nothing is selected. */
  onSelect?: (groupId: string | null) => void;
}

/** Default label for the nth group a user creates. */
function defaultGroupName(existing: number): string {
  return `Group ${existing + 1}`;
}

export class LayerGroupsPanel {
  private readonly _store = new LayerGroupStore();
  private readonly _rows: HTMLElement;
  private readonly _deps: LayerGroupsPanelDeps;
  /** Group headers by group id, so a header can be re-read without a rebuild. */
  private readonly _headers = new Map<string, GroupHeader>();
  /** The selected group, or null. Panel-local: it targets nothing but the UI. */
  private _selected: string | null = null;
  /** Groups whose member picker is open. */
  private readonly _picking = new Set<string>();

  /**
   * @param rows the Inspector's `.olv-layers` container — the one place layer
   *   rows are mounted, and the node this panel rearranges.
   */
  constructor(rows: HTMLElement, deps: LayerGroupsPanelDeps) {
    this._rows = rows;
    this._deps = deps;
  }

  /**
   * Create a group and show its member picker.
   *
   * A new group opens empty with the picker showing, because the next thing the
   * user needs is to say which layers belong to it; the default label keeps the
   * row addressable until they rename it.
   */
  createGroup(): LayerGroup {
    const group = this._store.create(defaultGroupName(this._store.groups().length));
    this._picking.add(group.id);
    this._select(group.id);
    this.render();
    return group;
  }

  /** The selected group's id, or null. */
  selectedGroupId(): string | null {
    return this._selected;
  }

  /** The group holding a layer, or null when it is ungrouped. */
  groupOf(layerId: string): LayerGroup | null {
    return this._store.groupOf(layerId);
  }

  /**
   * Rebuild the rows: every group in creation order with its live members
   * nested under it, then every ungrouped layer in scene order.
   *
   * The tree is built FROM the live id list on every paint, so a closed scan
   * leaves the panel the moment its row does, whether or not `reconcile` has
   * caught up with the membership record yet.
   */
  render(): void {
    const ids = this._deps.layerIds();
    this._store.reconcile(ids);
    this._headers.clear();
    const frame = document.createDocumentFragment();
    for (const node of this._store.tree(ids)) {
      if (node.kind === 'layer') {
        const row = this._deps.rowFor(node.layerId);
        if (row) frame.append(row);
        continue;
      }
      frame.append(this._renderGroup(node.group, node.memberIds, ids));
    }
    // The rows are MOVED into the fragment above, so replaceChildren re-mounts
    // the very same elements. Rebuilding them instead would drop the CRS flags,
    // lock state and listeners the Inspector put on each one.
    this._rows.replaceChildren(frame);
  }

  /**
   * Re-read every group header from its members without rebuilding the rows.
   * Called when a single layer's visibility changes, so the header a group's
   * members roll up into follows a row click immediately.
   */
  syncHeaders(): void {
    const ids = this._deps.layerIds();
    const visibility = this._visibilityMap(ids);
    for (const [groupId, header] of this._headers) {
      const group = this._store.get(groupId);
      if (group) header.sync(group, visibility, ids);
    }
  }

  /** Drop every group. The layers themselves are untouched. */
  reset(): void {
    for (const group of this._store.groups()) this._store.delete(group.id);
    this._headers.clear();
    this._picking.clear();
    this._select(null);
  }

  /**
   * The arrangement as a session records it — stable layer ids only.
   *
   * A member with no proven identity is left out rather than written under the
   * viewer handle that names it this session: `cloud_2` is a slot, and a file
   * that stored one would restore the group around whichever scan happened to
   * take that slot next time. An empty group is still written; it is a
   * container the user made, and losing it on export would delete work.
   */
  groupsForSession(): SessionLayerGroup[] {
    const ids = this._deps.layerIds();
    this._store.reconcile(ids);
    const out: SessionLayerGroup[] = [];
    for (const group of this._store.groups()) {
      const memberIds: string[] = [];
      for (const layerId of this._store.liveMembersOf(group.id, ids)) {
        const stable = this._deps.stableIdOf(layerId);
        if (stable !== null && stable !== '') memberIds.push(stable);
      }
      const record: SessionLayerGroup = { id: group.id, name: group.name, memberIds };
      if (group.collapsed) record.collapsed = true;
      out.push(record);
    }
    return out;
  }

  /**
   * Replace the arrangement with a session's.
   *
   * Groups are re-created rather than adopted whole, so each gets a fresh id
   * from the store's own generator. Nothing outside the panel references a
   * group id — measurements and annotations are owned by LAYER, not by group —
   * so the handle is free to change, and minting locally is what guarantees an
   * imported file can never hand two groups the same id.
   *
   * A member whose scan is not open is dropped: the group is restored around
   * the layers actually loaded, and re-importing after opening the rest of the
   * project restores the rest.
   */
  restoreFromSession(records: readonly SessionLayerGroup[]): void {
    this.reset();
    const byStable = new Map<string, string>();
    for (const layerId of this._deps.layerIds()) {
      const stable = this._deps.stableIdOf(layerId);
      if (stable !== null && stable !== '' && !byStable.has(stable)) byStable.set(stable, layerId);
    }
    for (const record of records) {
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (name === '') continue;
      const group = this._store.create(name);
      for (const stable of record.memberIds ?? []) {
        const layerId = byStable.get(stable);
        if (layerId !== undefined) this._store.addMember(group.id, layerId);
      }
      if (record.collapsed) this._store.setCollapsed(group.id, true);
    }
    this.render();
  }

  /** Per-layer intent as a map, the shape `groupVisibilityIntent` reads. */
  private _visibilityMap(ids: readonly string[]): Map<string, boolean> {
    const map = new Map<string, boolean>();
    for (const id of ids) map.set(id, this._deps.visibilityOf(id));
    return map;
  }

  private _select(groupId: string | null): void {
    if (this._selected === groupId) return;
    this._selected = groupId;
    this._deps.onSelect?.(groupId);
  }

  /**
   * Apply a group visibility decision.
   *
   * Every id goes through the per-layer writer, so the app's visibility path
   * runs once per layer exactly as it would have had the user clicked each row.
   */
  private _applyVisibility(entries: readonly (readonly [string, boolean])[]): void {
    for (const [layerId, visible] of entries) this._deps.setVisible(layerId, visible);
    this.syncHeaders();
  }

  private _renderGroup(
    group: LayerGroup,
    memberIds: readonly string[],
    allIds: readonly string[],
  ): HTMLElement {
    const header = new GroupHeader(group, {
      onFold: (collapsed) => {
        this._store.setCollapsed(group.id, collapsed);
        this.render();
      },
      onSelect: () => {
        this._select(this._selected === group.id ? null : group.id);
        this._paintSelection();
      },
      onRename: (name) => {
        // A blank rename is the user's slip, not a caller bug: the model
        // refuses it and the header restores the label it had.
        const renamed = this._store.rename(group.id, name);
        if (renamed) this.render();
        return renamed !== null;
      },
      onToggleVisible: () => {
        const live = this._store.get(group.id);
        if (!live) return;
        const state = groupVisibilityIntent(live, this._visibilityMap(allIds));
        if (state === 'empty') return;
        // Mixed resolves to "show everything": the click that follows a partly
        // shown group is the one that brings the rest back, and a second click
        // then hides the lot.
        const target = state !== 'all';
        this._applyVisibility(
          this._store.liveMembersOf(group.id, allIds).map((id) => [id, target] as const),
        );
      },
      onSolo: () => {
        const live = this._store.get(group.id);
        if (!live) return;
        const plan = soloGroupIntent(live, allIds);
        // Null means the group has no loaded member; isolating it would blank
        // the viewport with nothing on screen to explain why. The control is
        // disabled in that state, so this is the belt to that brace.
        if (!plan) return;
        this._applyVisibility([
          ...plan.visible.map((id) => [id, true] as const),
          ...plan.hidden.map((id) => [id, false] as const),
        ]);
      },
      onTogglePicker: () => {
        if (this._picking.has(group.id)) this._picking.delete(group.id);
        else this._picking.add(group.id);
        this.render();
      },
      onDelete: () => {
        // The members stay loaded and become ungrouped; a container going away
        // must not take the scans inside it out of the scene.
        this._store.delete(group.id);
        this._picking.delete(group.id);
        if (this._selected === group.id) this._select(null);
        this.render();
      },
    });
    this._headers.set(group.id, header);
    header.sync(group, this._visibilityMap(allIds), allIds);
    header.setSelected(this._selected === group.id);

    const body = el('div', { className: 'olv-group-members' });
    for (const layerId of memberIds) {
      const row = this._deps.rowFor(layerId);
      if (row) body.append(row);
    }
    body.classList.toggle('olv-hidden', group.collapsed);

    const children: HTMLElement[] = [header.element, body];
    if (this._picking.has(group.id)) children.push(this._renderPicker(group, allIds));
    const box = el('div', { className: 'olv-group' }, children);
    box.dataset.groupId = group.id;
    return box;
  }

  /**
   * The membership editor: every loaded layer with a checkbox, checked when it
   * belongs to THIS group. Checking a layer held by another group moves it —
   * membership is exclusive, so there is no state in which a layer shows as
   * checked under two headers.
   */
  private _renderPicker(group: LayerGroup, allIds: readonly string[]): HTMLElement {
    const rows: HTMLElement[] = [];
    for (const layerId of allIds) {
      const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
      box.type = 'checkbox';
      box.checked = this._store.groupOf(layerId)?.id === group.id;
      box.addEventListener('change', () => {
        if (box.checked) this._store.addMember(group.id, layerId);
        else this._store.removeMember(group.id, layerId);
        this.render();
      });
      const owner = this._store.groupOf(layerId);
      const elsewhere = owner && owner.id !== group.id ? ` (in ${owner.name})` : '';
      rows.push(
        el('label', { className: 'olv-group-pick' }, [
          box,
          el('span', { text: `${this._deps.nameOf(layerId)}${elsewhere}` }),
        ]),
      );
    }
    if (rows.length === 0) {
      rows.push(el('p', { className: 'olv-group-pick-empty', text: 'No layers loaded.' }));
    }
    return el('div', { className: 'olv-group-picker' }, rows);
  }

  /** Repaint the selection ring without rebuilding anything. */
  private _paintSelection(): void {
    for (const [groupId, header] of this._headers) {
      header.setSelected(this._selected === groupId);
    }
  }
}

/** What a header reports back to the panel. */
interface GroupHeaderActions {
  onFold: (collapsed: boolean) => void;
  onSelect: () => void;
  /** Returns false when the model refused the name, so the label can revert. */
  onRename: (name: string) => boolean;
  onToggleVisible: () => void;
  onSolo: () => void;
  onTogglePicker: () => void;
  onDelete: () => void;
}

/**
 * One group's header row.
 *
 * Holds no group state — {@link sync} is handed the current group and the live
 * per-layer intent every time, and every control reports an intent upwards
 * rather than deciding anything itself.
 */
class GroupHeader {
  readonly element: HTMLElement;
  private readonly _fold: HTMLButtonElement;
  private readonly _visible: HTMLInputElement;
  private readonly _name: HTMLButtonElement;
  private readonly _count: HTMLElement;
  private readonly _solo: HTMLButtonElement;
  private readonly _actions: GroupHeaderActions;
  private _label: string;

  constructor(group: LayerGroup, actions: GroupHeaderActions) {
    this._actions = actions;
    this._label = group.name;

    this._fold = el('button', {
      className: 'olv-group-fold',
      type: 'button',
      text: group.collapsed ? '▸' : '▾',
      ariaLabel: `Expand or collapse ${group.name}`,
    }) as HTMLButtonElement;
    this._fold.type = 'button';
    this._fold.addEventListener('click', () => {
      this._actions.onFold(this._fold.getAttribute('aria-expanded') === 'true');
    });

    this._visible = el('input', { type: 'checkbox', title: 'Show or hide every layer in this group' }) as HTMLInputElement;
    this._visible.type = 'checkbox';
    this._visible.addEventListener('change', () => this._actions.onToggleVisible());

    this._name = el('button', {
      className: 'olv-group-name',
      type: 'button',
      text: group.name,
      title: 'Click to select this group, double-click to rename it',
    }) as HTMLButtonElement;
    this._name.type = 'button';
    this._name.addEventListener('click', () => this._actions.onSelect());
    this._name.addEventListener('dblclick', () => this.beginRename());

    this._count = el('span', { className: 'olv-group-count' });

    const rename = el('button', {
      className: 'olv-group-rename',
      type: 'button',
      text: '✎',
      title: `Rename ${group.name}`,
      ariaLabel: `Rename ${group.name}`,
    }) as HTMLButtonElement;
    rename.type = 'button';
    rename.addEventListener('click', () => this.beginRename());

    this._solo = el('button', {
      className: 'olv-group-solo',
      type: 'button',
      text: '◉',
      title: `Show only ${group.name}`,
      ariaLabel: `Show only ${group.name}`,
    }) as HTMLButtonElement;
    this._solo.type = 'button';
    this._solo.addEventListener('click', () => this._actions.onSolo());

    const pick = el('button', {
      className: 'olv-group-add',
      type: 'button',
      text: '⊞',
      title: `Choose which layers are in ${group.name}`,
      ariaLabel: `Choose which layers are in ${group.name}`,
    }) as HTMLButtonElement;
    pick.type = 'button';
    pick.addEventListener('click', () => this._actions.onTogglePicker());

    const remove = el('button', {
      className: 'olv-layer-x olv-group-x',
      type: 'button',
      text: '×',
      title: `Delete ${group.name} — its layers stay loaded`,
      ariaLabel: `Delete the group ${group.name}`,
    }) as HTMLButtonElement;
    remove.type = 'button';
    remove.addEventListener('click', () => this._actions.onDelete());

    this.element = el('div', { className: 'olv-group-head' }, [
      this._fold,
      this._visible,
      this._name,
      this._count,
      rename,
      this._solo,
      pick,
      remove,
    ]);
  }

  /** Swap the label for an input and commit on Enter or blur. */
  beginRename(): void {
    if (this.element.querySelector('.olv-group-rename-input')) return;
    const input = el('input', { className: 'olv-group-rename-input' }) as HTMLInputElement;
    input.type = 'text';
    input.value = this._label;
    input.setAttribute('aria-label', `Group name for ${this._label}`);
    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      const accepted = commit && this._actions.onRename(input.value);
      // A refused (blank) name leaves the group exactly as it was; the label
      // comes back rather than the row turning nameless.
      if (!accepted) {
        input.replaceWith(this._name);
        this._name.textContent = this._label;
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    this._name.replaceWith(input);
    input.focus();
    input.select();
  }

  setSelected(selected: boolean): void {
    this.element.classList.toggle('is-selected', selected);
    this._name.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }

  /** Re-read the header from the group and the live per-layer intent. */
  sync(
    group: LayerGroup,
    visibility: ReadonlyMap<string, boolean>,
    allIds: readonly string[],
  ): void {
    this._label = group.name;
    this._name.textContent = group.name;
    this.element.setAttribute('aria-label', group.name);
    this._fold.textContent = group.collapsed ? '▸' : '▾';
    this._fold.setAttribute('aria-expanded', group.collapsed ? 'false' : 'true');

    const live = new Set(allIds);
    const loaded = group.memberIds.filter((id) => live.has(id)).length;
    this._count.textContent = loaded === 1 ? '1 layer' : `${loaded} layers`;

    const state = groupVisibilityIntent(group, visibility);
    // `empty` is not `none`: a group with nothing loaded has nothing hidden, so
    // it gets a disabled control rather than an unchecked box inviting a click
    // that would do nothing.
    this._visible.checked = state === 'all';
    this._visible.indeterminate = state === 'mixed';
    this._visible.disabled = state === 'empty';
    this._solo.disabled = soloGroupIntent(group, allIds) === null;
    this.element.classList.toggle('olv-group-empty', state === 'empty');
  }
}
