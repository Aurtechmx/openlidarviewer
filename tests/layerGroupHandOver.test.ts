/**
 * tests/layerGroupHandOver.test.ts
 *
 * A density reload opens the same source again and hands the original layer's
 * stable identity to the copy before the original is closed. The Layers panel
 * keys its groups and its cached stable ids by viewer id, so both have to
 * follow the hand-over: the copy takes the original's place in its group, and
 * its row reports the kept stable id, so a session saved after the reload
 * records the group around the same scan.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LayerGroupStore } from '../src/model/layerGroups';
import { Inspector } from '../src/ui/Inspector';
import { handOverLayerWork } from '../src/app/measurementOwnership';
import { installInspectorFakeDom, fakeCallbacks } from './helpers/inspectorLazyHarness';

/** Let the lazily imported group panel land. */
const settle = (inspector: Inspector): Promise<void> =>
  vi.waitFor(() => { expect((inspector as unknown as { _groups: unknown })._groups).toBeTruthy(); });

vi.mock('../src/lazyChunks', () => ({
  loadLayerHealthCard: vi.fn(() => new Promise(() => {})),
  loadLayerGroupsPanel: vi.fn(() => import('../src/ui/LayerGroupsPanel')),
}));

beforeAll(() => {
  installInspectorFakeDom();
});

describe('LayerGroupStore.replaceMember', () => {
  it('puts the new id in the old one’s group, at the same position', () => {
    const store = new LayerGroupStore();
    const g = store.create('G', ['a', 'b', 'c']);
    expect(store.replaceMember('b', 'b2')).toBe(true);
    expect(store.membersOf(g.id)).toEqual(['a', 'b2', 'c']);
    expect(store.groupOf('b2')?.id).toBe(g.id);
    expect(store.groupOf('b')).toBeNull();
  });

  it('is a no-op for an ungrouped layer, and moves the new id out of any group it was in', () => {
    const store = new LayerGroupStore();
    const g1 = store.create('G1', ['a']);
    const g2 = store.create('G2', ['n']);
    expect(store.replaceMember('loose', 'x')).toBe(false);
    expect(store.replaceMember('a', 'n')).toBe(true);
    expect(store.membersOf(g1.id)).toEqual(['n']);
    expect(store.membersOf(g2.id)).toEqual([]);
  });
});

describe('Inspector follows a density reload hand-over', () => {
  async function reloadedInspector() {
    const inspector = new Inspector(fakeCallbacks());
    inspector.addCloud('cloud_1', 'a.las', 10, null, 'stable-a');
    inspector.addCloud('cloud_2', 'b.las', 10, null, 'stable-b');
    inspector.restoreLayerGroups([{ id: 'g', name: 'Survey', memberIds: ['stable-a'] }]);
    await settle(inspector);
    expect(inspector.layerGroupsForSession().map((g) => g.memberIds)).toEqual([['stable-a']]);
    // The reloaded copy opens with an id of its own, then is handed the original's.
    inspector.addCloud('cloud_3', 'a.las', 20, null, 'stable-minted');
    return inspector;
  }

  it('without the hand-over, closing the original drops the scan from its group (the defect)', async () => {
    const inspector = await reloadedInspector();
    inspector.removeCloud('cloud_1');
    expect(inspector.layerGroupsForSession().map((g) => g.memberIds)).toEqual([[]]);
  });

  it('the copy takes the original’s place in its group and reports the kept stable id', async () => {
    const inspector = await reloadedInspector();
    inspector.handOverLayer('cloud_1', 'cloud_3', 'stable-a');
    inspector.removeCloud('cloud_1');
    expect(inspector.layerGroupsForSession()).toEqual([{ id: expect.any(String), name: 'Survey', memberIds: ['stable-a'] }]);
  });

  it('an ungrouped layer still reports the kept stable id once grouped after the reload', async () => {
    const inspector = new Inspector(fakeCallbacks());
    inspector.addCloud('cloud_1', 'a.las', 10, null, 'stable-a');
    inspector.addCloud('cloud_3', 'a.las', 20, null, 'stable-minted');
    inspector.handOverLayer('cloud_1', 'cloud_3', 'stable-a');
    inspector.removeCloud('cloud_1');
    inspector.restoreLayerGroups([{ id: 'g', name: 'Later', memberIds: ['stable-a'] }]);
    await settle(inspector);
    expect(inspector.layerGroupsForSession().map((g) => g.memberIds)).toEqual([['stable-a']]);
  });
});

describe('handOverLayerWork tells the Layers panel', () => {
  it('passes the kept stable id to the rows once the identity is handed over', () => {
    const rows = { handOverLayer: vi.fn() };
    const identity = { handOver: () => ({ kept: 'stable-a', released: 'stable-minted' }) };
    expect(handOverLayerWork(identity, null, 'cloud_1', 'cloud_3', rows)).toBe(true);
    expect(rows.handOverLayer).toHaveBeenCalledWith('cloud_1', 'cloud_3', 'stable-a');
  });

  it('leaves the rows alone when the identity service refuses', () => {
    const rows = { handOverLayer: vi.fn() };
    expect(handOverLayerWork({ handOver: () => null }, null, 'cloud_1', 'cloud_3', rows)).toBe(false);
    expect(rows.handOverLayer).not.toHaveBeenCalled();
  });
});
