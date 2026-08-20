/**
 * layerGroupsPanel.test.ts
 *
 * The Layers panel's group rows, at the DOM level via the same recording stub
 * the other panel tests use (there is no jsdom in this repo).
 *
 * The property under test is the one the group model was built around: a group
 * stores ids and nothing else, so every group ACTION has to arrive at the app
 * as per-layer writes through the visibility path a single row already uses.
 * These tests assert that shape directly — a "hide the group" click is six
 * `setVisible` calls and no group flag, and a group's checkbox is recomputed
 * from its members rather than remembered.
 *
 * Also pinned: the rows are MOVED, not rebuilt (a grouped layer keeps the row
 * the Inspector built, with its listeners and CRS classes), an empty group is a
 * distinct state from a hidden one, and membership persists by stable layer id
 * so an arrangement cannot restore around the wrong scan.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LayerGroupsPanel } from '../src/ui/LayerGroupsPanel';
import type { SessionLayerGroup } from '../src/io/session';

type Handler = (e: unknown) => void;

/** A recording DOM node covering only the surface the group panel touches. */
class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  textContent = '';
  title = '';
  value = '';
  type = '';
  checked = false;
  indeterminate = false;
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  set className(v: string) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className(): string {
    return [...this._classes].join(' ');
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (c: string): void => void classes.add(c),
      remove: (c: string): void => void classes.delete(c),
      contains: (c: string): boolean => classes.has(c),
      toggle: (c: string, force?: boolean): boolean => {
        const want = force === undefined ? !classes.has(c) : force;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    };
  }

  private _adopt(kid: unknown): FakeEl[] {
    if (kid instanceof FakeEl) {
      // A fragment contributes its children, exactly as the real DOM does.
      if (kid.tagName === '#fragment') {
        const kids = [...kid.children];
        kid.children.length = 0;
        for (const k of kids) k.parent = this;
        return kids;
      }
      kid.parent?.detach(kid);
      kid.parent = this;
      return [kid];
    }
    const text = new FakeEl('#text');
    text.textContent = String(kid);
    text.parent = this;
    return [text];
  }
  detach(kid: FakeEl): void {
    const at = this.children.indexOf(kid);
    if (at >= 0) this.children.splice(at, 1);
  }
  append(...kids: unknown[]): void {
    for (const k of kids) this.children.push(...this._adopt(k));
  }
  replaceChildren(...kids: unknown[]): void {
    this.children.length = 0;
    for (const k of kids) this.children.push(...this._adopt(k));
  }
  remove(): void {
    this.parent?.detach(this);
    this.parent = null;
  }
  replaceWith(node: FakeEl): void {
    const parent = this.parent;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    this.parent = null;
    if (at < 0) return;
    node.parent?.detach(node);
    node.parent = parent;
    parent.children[at] = node;
  }

  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }

  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  dispatchEvent(evt: { type: string; key?: string }): boolean {
    for (const fn of [...(this.handlers.get(evt.type) ?? [])]) fn(evt);
    return true;
  }
  focus(): void {}
  blur(): void {}
  select(): void {}

  /** `tag`, `.class`, or `tag.class` — the only selector shapes in play. */
  private _matches(sel: string): boolean {
    const parts = sel.split('.');
    const tag = parts[0];
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    for (const c of parts.slice(1)) if (!this._classes.has(c)) return false;
    return true;
  }
  querySelector(sel: string): FakeEl | null {
    for (const c of this.children) {
      if (c._matches(sel)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      for (const c of n.children) {
        if (c._matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createDocumentFragment: () => new FakeEl('#fragment'),
  };
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
});

interface Layer {
  id: string;
  name: string;
  /** null models a scan the identity registry refused a binding. */
  stableId: string | null;
}

function mount(layers: Layer[]) {
  const order = layers.map((l) => l.id);
  const facts = new Map(layers.map((l) => [l.id, l]));
  const rows = new Map<string, FakeEl>();
  for (const layer of layers) {
    const row = new FakeEl('div');
    row.className = 'olv-layer';
    row.dataset.layerId = layer.id;
    rows.set(layer.id, row);
  }
  const visible = new Map<string, boolean>(order.map((id) => [id, true]));
  const setVisible = vi.fn((id: string, on: boolean) => void visible.set(id, on));
  const host = new FakeEl('div');
  const panel = new LayerGroupsPanel(host as unknown as HTMLElement, {
    layerIds: () => order,
    nameOf: (id) => facts.get(id)?.name ?? id,
    rowFor: (id) => (rows.get(id) ?? null) as unknown as HTMLElement | null,
    visibilityOf: (id) => visible.get(id) ?? true,
    setVisible,
    stableIdOf: (id) => facts.get(id)?.stableId ?? null,
  });
  panel.render();

  const closeLayer = (id: string): void => {
    order.splice(order.indexOf(id), 1);
    rows.get(id)?.remove();
    rows.delete(id);
    visible.delete(id);
    panel.render();
  };
  const newGroup = (): FakeEl => {
    panel.createGroup();
    return heads()[heads().length - 1];
  };
  const heads = (): FakeEl[] => host.querySelectorAll('.olv-group-head');
  const groupBox = (index: number): FakeEl => host.querySelectorAll('.olv-group')[index];
  /** Tick the picker box for `layerId` inside the group at `index`. */
  const addMember = (index: number, layerId: string): void => {
    const picks = groupBox(index).querySelectorAll('.olv-group-pick');
    const at = order.indexOf(layerId);
    const box = picks[at].children[0];
    box.checked = !box.checked;
    box.dispatchEvent({ type: 'change' });
  };

  return { panel, host, rows, visible, setVisible, heads, groupBox, newGroup, addMember, closeLayer };
}

/** The layer ids the host renders, in order, however deeply they are nested. */
function renderedOrder(host: FakeEl): string[] {
  const out: string[] = [];
  const walk = (node: FakeEl): void => {
    for (const child of node.children) {
      if (child.className.split(/\s+/).includes('olv-layer')) out.push(child.dataset.layerId);
      else walk(child);
    }
  };
  walk(host);
  return out;
}

const LAYERS: Layer[] = [
  { id: 'cloud_1', name: 'Strip A', stableId: 'layer-a' },
  { id: 'cloud_2', name: 'Strip B', stableId: 'layer-b' },
  { id: 'cloud_3', name: 'Strip C', stableId: null },
];

describe('LayerGroupsPanel — arrangement', () => {
  it('leaves ungrouped layers as flat rows in scene order', () => {
    const h = mount(LAYERS);
    expect(h.heads()).toHaveLength(0);
    expect(renderedOrder(h.host)).toEqual(['cloud_1', 'cloud_2', 'cloud_3']);
    expect(h.host.children.map((c) => c.className)).toEqual([
      'olv-layer',
      'olv-layer',
      'olv-layer',
    ]);
  });

  it('nests members under a group header and keeps the ungrouped rows below', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_1');
    h.addMember(0, 'cloud_3');
    const members = h.groupBox(0).querySelector('.olv-group-members');
    expect(members?.children.map((c) => c.dataset.layerId)).toEqual(['cloud_1', 'cloud_3']);
    // Every loaded layer still appears exactly once, grouped or not.
    expect(renderedOrder(h.host).sort()).toEqual(['cloud_1', 'cloud_2', 'cloud_3']);
    expect(h.host.children[h.host.children.length - 1].dataset.layerId).toBe('cloud_2');
  });

  it('moves the row the Inspector built rather than rebuilding it', () => {
    const h = mount(LAYERS);
    const original = h.rows.get('cloud_2');
    h.newGroup();
    h.addMember(0, 'cloud_2');
    const members = h.groupBox(0).querySelector('.olv-group-members');
    // Identity, not equality: a rebuilt row would drop the listeners, lock
    // state and CRS classes the Inspector put on this element.
    expect(members?.children[0]).toBe(original);
  });

  it('reports a member count and keeps a group whose last scan closed', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_1');
    expect(h.groupBox(0).querySelector('.olv-group-count')?.textContent).toBe('1 layer');
    h.closeLayer('cloud_1');
    expect(h.heads()).toHaveLength(1);
    expect(h.groupBox(0).querySelector('.olv-group-count')?.textContent).toBe('0 layers');
    expect(renderedOrder(h.host)).toEqual(['cloud_2', 'cloud_3']);
  });

  it('moves a layer out of its old group when a second group claims it', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_1');
    h.newGroup();
    h.addMember(1, 'cloud_1');
    expect(h.groupBox(0).querySelector('.olv-group-members')?.children).toHaveLength(0);
    expect(
      h.groupBox(1).querySelector('.olv-group-members')?.children.map((c) => c.dataset.layerId),
    ).toEqual(['cloud_1']);
  });

  it('deleting a group leaves its layers loaded and ungrouped', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_1');
    h.groupBox(0).querySelector('.olv-group-x')?.dispatchEvent({ type: 'click' });
    expect(h.heads()).toHaveLength(0);
    expect(renderedOrder(h.host)).toEqual(['cloud_1', 'cloud_2', 'cloud_3']);
  });
});

describe('LayerGroupsPanel — visibility is written, never stored', () => {
  it('hides a group as one write per member, through the per-layer path', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_1');
    h.addMember(0, 'cloud_2');
    h.setVisible.mockClear();
    h.groupBox(0).querySelector('.olv-group-head')?.children[1].dispatchEvent({ type: 'change' });
    expect(h.setVisible.mock.calls).toEqual([
      ['cloud_1', false],
      ['cloud_2', false],
    ]);
    // Nothing was written to the third layer: a group speaks for its members only.
    expect(h.visible.get('cloud_3')).toBe(true);
  });

  it('reads mixed from its members, then resolves the click to "show all"', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_1');
    h.addMember(0, 'cloud_2');
    h.visible.set('cloud_1', false);
    h.panel.syncHeaders();
    const box = h.groupBox(0).querySelector('.olv-group-head')?.children[1];
    expect(box?.indeterminate).toBe(true);
    expect(box?.checked).toBe(false);
    box?.dispatchEvent({ type: 'change' });
    expect(h.visible.get('cloud_1')).toBe(true);
    expect(h.visible.get('cloud_2')).toBe(true);
    expect(box?.indeterminate).toBe(false);
    expect(box?.checked).toBe(true);
  });

  it('follows a single row toggle without a repaint', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_1');
    h.addMember(0, 'cloud_2');
    h.visible.set('cloud_2', false);
    h.panel.syncHeaders();
    expect(h.groupBox(0).querySelector('.olv-group-head')?.children[1].indeterminate).toBe(true);
  });

  it('treats an empty group as empty, not as hidden', () => {
    const h = mount(LAYERS);
    h.newGroup();
    const head = h.heads()[0];
    // Nothing is hidden, so the control is disabled rather than showing an
    // unchecked box that invites a click which would do nothing.
    expect(head.children[1].disabled).toBe(true);
    expect(head.querySelector('.olv-group-solo')?.disabled).toBe(true);
    expect(head.className.split(/\s+/)).toContain('olv-group-empty');
    h.setVisible.mockClear();
    head.children[1].dispatchEvent({ type: 'change' });
    head.querySelector('.olv-group-solo')?.dispatchEvent({ type: 'click' });
    expect(h.setVisible).not.toHaveBeenCalled();
  });

  it('isolates a group as a partition of every loaded layer', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_2');
    h.setVisible.mockClear();
    h.groupBox(0).querySelector('.olv-group-solo')?.dispatchEvent({ type: 'click' });
    expect(h.setVisible.mock.calls).toEqual([
      ['cloud_2', true],
      ['cloud_1', false],
      ['cloud_3', false],
    ]);
  });
});

describe('LayerGroupsPanel — header controls', () => {
  it('renames inline on Enter', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.groupBox(0).querySelector('.olv-group-rename')?.dispatchEvent({ type: 'click' });
    const input = h.groupBox(0).querySelector('.olv-group-rename-input');
    expect(input).not.toBeNull();
    input!.value = '  Flight 2  ';
    input!.dispatchEvent({ type: 'keydown', key: 'Enter' });
    expect(h.groupBox(0).querySelector('.olv-group-name')?.textContent).toBe('Flight 2');
  });

  it('refuses a blank rename and puts the old label back', () => {
    const h = mount(LAYERS);
    h.newGroup();
    const before = h.groupBox(0).querySelector('.olv-group-name')?.textContent;
    h.groupBox(0).querySelector('.olv-group-rename')?.dispatchEvent({ type: 'click' });
    const input = h.groupBox(0).querySelector('.olv-group-rename-input');
    input!.value = '   ';
    input!.dispatchEvent({ type: 'keydown', key: 'Enter' });
    expect(h.groupBox(0).querySelector('.olv-group-name')?.textContent).toBe(before);
    expect(h.groupBox(0).querySelector('.olv-group-rename-input')).toBeNull();
  });

  it('folds and unfolds without unloading the member rows', () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_1');
    const fold = () => h.groupBox(0).querySelector('.olv-group-fold')!;
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    fold().dispatchEvent({ type: 'click' });
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    const members = h.groupBox(0).querySelector('.olv-group-members')!;
    expect(members.className.split(/\s+/)).toContain('olv-hidden');
    expect(members.children).toHaveLength(1);
    fold().dispatchEvent({ type: 'click' });
    expect(fold().getAttribute('aria-expanded')).toBe('true');
  });

  it('selects a group and clears the selection on a second click', () => {
    const h = mount(LAYERS);
    h.newGroup();
    const name = () => h.groupBox(0).querySelector('.olv-group-name')!;
    // Creating a group selects it, so start from a cleared state.
    name().dispatchEvent({ type: 'click' });
    expect(h.panel.selectedGroupId()).toBeNull();
    name().dispatchEvent({ type: 'click' });
    expect(h.panel.selectedGroupId()).not.toBeNull();
    expect(h.heads()[0].className.split(/\s+/)).toContain('is-selected');
  });
});

describe('LayerGroupsPanel — session round trip', () => {
  const arranged = () => {
    const h = mount(LAYERS);
    h.newGroup();
    h.addMember(0, 'cloud_1');
    h.addMember(0, 'cloud_3');
    h.groupBox(0).querySelector('.olv-group-fold')?.dispatchEvent({ type: 'click' });
    return h;
  };

  it('writes membership by stable id and omits a layer that has none', () => {
    const written = arranged().panel.groupsForSession();
    expect(written).toHaveLength(1);
    // cloud_3 carries no proven identity, so it is left out rather than written
    // under a viewer handle that would name a different scan next session.
    expect(written[0].memberIds).toEqual(['layer-a']);
    expect(written[0].collapsed).toBe(true);
  });

  it('keeps an empty group and omits the collapsed key when expanded', () => {
    const h = mount(LAYERS);
    h.newGroup();
    const written = h.panel.groupsForSession();
    expect(written[0].memberIds).toEqual([]);
    expect(written[0].collapsed).toBeUndefined();
  });

  it('restores an arrangement onto the layers that are open, dropping the rest', () => {
    const h = mount(LAYERS);
    const records: SessionLayerGroup[] = [
      { id: 'group_x', name: 'Flight 1', memberIds: ['layer-b', 'layer-missing'], collapsed: true },
      { id: 'group_y', name: 'Flight 2', memberIds: ['layer-a'] },
    ];
    h.panel.restoreFromSession(records);
    expect(h.heads()).toHaveLength(2);
    expect(
      h.groupBox(0).querySelector('.olv-group-members')?.children.map((c) => c.dataset.layerId),
    ).toEqual(['cloud_2']);
    expect(h.groupBox(0).querySelector('.olv-group-fold')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(
      h.groupBox(1).querySelector('.olv-group-members')?.children.map((c) => c.dataset.layerId),
    ).toEqual(['cloud_1']);
    expect(renderedOrder(h.host)).toEqual(['cloud_2', 'cloud_1', 'cloud_3']);
  });

  it('replaces whatever was arranged before', () => {
    const h = arranged();
    h.panel.restoreFromSession([{ id: 'g', name: 'Only', memberIds: [] }]);
    expect(h.heads()).toHaveLength(1);
    expect(h.groupBox(0).querySelector('.olv-group-name')?.textContent).toBe('Only');
    expect(renderedOrder(h.host)).toEqual(['cloud_1', 'cloud_2', 'cloud_3']);
  });

  it('survives a write / read cycle through its own two adapters', () => {
    const source = arranged();
    const written = source.panel.groupsForSession();
    const target = mount(LAYERS);
    target.panel.restoreFromSession(written);
    expect(target.panel.groupsForSession().map((g) => ({ ...g, id: 'x' }))).toEqual(
      written.map((g) => ({ ...g, id: 'x' })),
    );
  });
});
