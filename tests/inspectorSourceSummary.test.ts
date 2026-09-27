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
});
