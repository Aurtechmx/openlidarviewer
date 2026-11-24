/**
 * The Data home's source row reads Inspector.sourceSummary() and refreshes on
 * onSourceChange, which fires on every layer, CRS and provenance change.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Inspector } from '../src/ui/Inspector';
import { installInspectorFakeDom, fakeCallbacks } from './helpers/inspectorLazyHarness';

beforeAll(installInspectorFakeDom);

describe('Inspector source summary signal', () => {
  it('reports format and CRS, and fires on layer add, CRS override and clear', () => {
    const ins = new Inspector(fakeCallbacks());
    const fn = vi.fn();
    ins.onSourceChange(fn);
    ins.addCloud('a', 'tile.laz', 10);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ins.sourceSummary()).toBe('LAZ');
    ins.setCrs({ kind: 'projected', name: 'NAD83 / UTM zone 15N', linearUnit: 'metre', linearUnitToMetres: 1 } as never);
    expect(ins.sourceSummary()).toBe('LAZ, NAD83 / UTM zone 15N');
    // A user override reaches the Inspector through the same setCrs path.
    ins.setCrs({ kind: 'projected', name: 'WGS 84 / UTM zone 15N', linearUnit: 'metre', linearUnitToMetres: 1 } as never);
    expect(ins.sourceSummary()).toBe('LAZ, WGS 84 / UTM zone 15N');
    ins.clearCrs();
    expect(ins.sourceSummary()).toBe('LAZ');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('names the active layer, and refreshes when the active layer changes', () => {
    const ins = new Inspector(fakeCallbacks());
    ins.addCloud('a', 'a.las', 10);
    ins.addCloud('b', 'b.ply', 10);
    const fn = vi.fn();
    ins.onSourceChange(fn);
    ins.setActiveLayer('a');
    expect(ins.sourceSummary()).toBe('LAS');
    expect(fn).toHaveBeenCalledTimes(1);
    ins.setActiveLayer('b');
    expect(ins.sourceSummary()).toBe('PLY');
    ins.setActiveLayer('gone');
    expect(ins.sourceSummary()).toBe('PLY');
  });
});

describe('the shown comparison', () => {
  it('is dropped when the scene says what it read has changed', () => {
    const key = new Map([['A', '1'], ['B', '1']]);
    const layers = new Map<string, object>([['A', {}], ['B', {}]]);
    const ins = new Inspector({
      ...fakeCallbacks(),
      compareScene: { slot: { lastDifference: null }, ids: () => [...layers.keys()], lookup: (id) => layers.get(id) as never, stableIdFor: (id) => id, inputKeyFor: (id) => key.get(id)! },
    });
    const said = vi.spyOn(ins, 'setCompareResult');
    ins.compareDifference.begin(['A', 'B'], layers.get('A'), layers.get('B'));
    ins.compareDifference.hold({ stem: 'a-to-b', asc: () => 'ncols 1' });
    ins.compareDifference.dropStale();
    expect(said).not.toHaveBeenCalled();
    key.set('B', '2');
    ins.compareDifference.dropStale();
    expect(said).toHaveBeenCalledWith([expect.stringContaining('Compare again')]);
  });
});
